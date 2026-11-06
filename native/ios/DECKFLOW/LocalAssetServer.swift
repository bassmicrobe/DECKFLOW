import Foundation
import Network

/// Read-only bundle server. A stable loopback origin retains IndexedDB between
/// launches and is considered potentially trustworthy for AudioWorklet.
// Mutable listener/connection state is confined to `queue`; origin/port are immutable.
final class LocalAssetServer: @unchecked Sendable {
    static let appPort: UInt16 = 49037
    let port: UInt16
    var origin: String { "http://127.0.0.1:\(port)" }
    var url: URL { URL(string: origin + "/")! }
    private let queue = DispatchQueue(label: "com.bassmicrobe.deckflow.assets")
    private var listener: NWListener?
    private var root: URL?
    private var connections: [UUID: NWConnection] = [:]
    private var pendingStart: ((Result<URL, Error>) -> Void)?

    init(port: UInt16 = LocalAssetServer.appPort) { self.port = port }

    func start(root: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                if listener != nil {
                    continuation.resume(throwing: ServerError("同梱サーバーは起動済みです。"))
                    return
                }
                self.root = root.resolvingSymlinksInPath().standardizedFileURL
                pendingStart = { continuation.resume(with: $0) }
                do {
                    let parameters = NWParameters.tcp
                    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
                    parameters.requiredInterfaceType = .loopback
                    parameters.includePeerToPeer = false
                    let listener = try NWListener(using: parameters)
                    self.listener = listener
                    listener.stateUpdateHandler = { [weak self] state in
                        guard let self else { return }
                        switch state {
                        case .ready: self.finishStart(.success(self.url))
                        case .failed(let error):
                            self.listener?.cancel(); self.listener = nil
                            self.finishStart(.failure(error))
                        case .cancelled: self.finishStart(.failure(ServerError("同梱サーバーが停止しました。")))
                        default: break
                        }
                    }
                    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
                    listener.start(queue: queue)
                } catch { finishStart(.failure(error)) }
            }
        }
    }

    private func finishStart(_ result: Result<URL, Error>) {
        let completion = pendingStart
        pendingStart = nil
        completion?(result)
    }

    func stop() {
        queue.async { [self] in
            listener?.cancel()
            listener = nil
            connections.values.forEach { $0.cancel() }
            connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 32 else { connection.cancel(); return }
        let id = UUID()
        connections[id] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            if case .cancelled = state { self?.connections.removeValue(forKey: id) }
            if case .failed = state { self?.connections.removeValue(forKey: id); connection?.cancel() }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 10) { [weak self, weak connection] in
            if self?.connections[id] != nil { connection?.cancel() }
        }
        receive(connection, accumulated: Data())
    }

    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var request = accumulated
            if let data { request.append(data) }
            if request.count > 16_384 { self.reply(connection, status: 431, body: Data()); return }
            if let boundary = request.range(of: Data([13, 10, 13, 10])) {
                self.handle(connection, header: request[..<boundary.lowerBound])
            } else if complete || error != nil { connection.cancel() }
            else { self.receive(connection, accumulated: request) }
        }
    }

    private func handle(_ connection: NWConnection, header: Data) {
        guard let request = String(data: header, encoding: .utf8) else { reply(connection, status: 400, body: Data()); return }
        let lines = request.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[2].hasPrefix("HTTP/1.") else { reply(connection, status: 400, body: Data()); return }
        guard first[0] == "GET" else { reply(connection, status: 405, body: Data()); return }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { reply(connection, status: 400, body: Data()); return }
            let name = line[..<colon].lowercased()
            guard headers[name] == nil else { reply(connection, status: 400, body: Data()); return }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["host"] == "127.0.0.1:\(port)" else { reply(connection, status: 403, body: Data()); return }
        if let originHeader = headers["origin"], originHeader != origin { reply(connection, status: 403, body: Data()); return }
        guard let root, let asset = Self.assetURL(target: String(first[1]), root: root) else { reply(connection, status: 403, body: Data()); return }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: asset.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else { reply(connection, status: 404, body: Data()); return }
            guard ((attributes[.size] as? NSNumber)?.intValue ?? .max) <= 32 * 1024 * 1024 else { reply(connection, status: 413, body: Data()); return }
            let body = try Data(contentsOf: asset, options: .mappedIfSafe)
            reply(connection, status: 200, body: body, contentType: Self.contentType(for: asset))
        } catch { reply(connection, status: 404, body: Data()); }
    }

    /// One percent decode, no dot segments, private hidden files, backslashes,
    /// or symlinks that resolve outside the bundled Web directory. The pinned
    /// SoundTouch vendor uses a public `.dist` folder, allowlisted below.
    static func assetURL(target: String, root: URL) -> URL? {
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              let decoded = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first?.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        let parts = decoded.split(separator: "/", omittingEmptySubsequences: true)
        for (index, part) in parts.enumerated() where part.hasPrefix(".") {
            let soundTouchPackages: Set<Substring> = ["audio-worklet", "worklet-base", "core", "interpolation-strategy-lanczos"]
            guard part == ".dist", index == 4, parts.count > 5,
                  parts[0] == "vendor", parts[1] == "soundtouchjs", parts[2] == "packages",
                  soundTouchPackages.contains(parts[3]) else { return nil }
        }
        let path = parts.isEmpty ? "index.html" : parts.joined(separator: "/")
        let base = root.resolvingSymlinksInPath().standardizedFileURL
        let result = base.appendingPathComponent(path).resolvingSymlinksInPath().standardizedFileURL
        guard result.path.hasPrefix(base.path + "/") else { return nil }
        return result
    }

    private static func contentType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "wav": return "audio/wav"
        case "mp3": return "audio/mpeg"
        case "woff2": return "font/woff2"
        case "md", "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    private func reply(_ connection: NWConnection, status: Int, body: Data, contentType: String = "text/plain") {
        let labels = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 431: "Request Header Fields Too Large"]
        let header = "HTTP/1.1 \(status) \(labels[status] ?? "Error")\r\nContent-Length: \(body.count)\r\nContent-Type: \(contentType)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        var response = Data(header.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }

    struct ServerError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}

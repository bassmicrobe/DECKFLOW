import Foundation
import CryptoKit

struct USBError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

/// All calls run on NativeUSB's serial I/O queue. The web page never supplies
/// an absolute URL. Journals live in the app sandbox; payloads/backups remain on
/// the selected volume so replacements do not cross filesystems.
final class NativeUSBStore {
    static let chunkLimit = 1024 * 1024
    static let stagingName = ".deckflow-transactions"
    let root: URL
    let rootID: String
    let journalDirectory: URL
    let manager = FileManager.default
    private let rootIdentity: String
    // Fault injection is confined to native unit tests, never exposed to JS.
    var afterInstall: ((Int) throws -> Void)?

    struct Write: Codable {
        let path: String
        let size: Int64
        let expectedFingerprint: String?
        var fingerprint: String?
        var phase: String = "pending"
    }
    struct Guard: Codable {
        let path: String
        let expectedFingerprint: String?
    }
    struct Journal: Codable {
        let version: Int
        let id: String
        let rootID: String
        var state: String
        var writes: [Write]
        var guards: [Guard]?
    }

    init(root: URL, rootID: String, journalDirectory: URL) throws {
        self.root = root.resolvingSymlinksInPath().standardizedFileURL
        self.rootID = rootID
        self.rootIdentity = try Self.identity(of: self.root)
        self.journalDirectory = journalDirectory
        try manager.createDirectory(at: journalDirectory, withIntermediateDirectories: true)
        try ensureConnected()
    }

    private static func identity(of url: URL) throws -> String {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let device = attributes[.systemNumber] as? NSNumber, let inode = attributes[.systemFileNumber] as? NSNumber else { throw USBError("USBの識別情報を読み込めません。") }
        return device.stringValue + ":" + inode.stringValue
    }

    func ensureConnected() throws {
        let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true, try Self.identity(of: root) == rootIdentity else {
            throw USBError("選択したUSBを開けません。接続を確認して選び直してください。")
        }
    }

    func safeURL(_ path: String, allowEmpty: Bool = false, internalPath: Bool = false) throws -> URL {
        if path.isEmpty && allowEmpty { return root }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, !path.hasPrefix("/"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains(":") }),
              internalPath || parts[0].lowercased() != Self.stagingName else { throw USBError("USB内のパスが不正です。") }
        var current = root
        for part in parts {
            current.appendPathComponent(part)
            if let attributes = try? manager.attributesOfItem(atPath: current.path) {
                guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else {
                    throw USBError("シンボリックリンクにはアクセスできません。")
                }
            }
            let resolved = current.resolvingSymlinksInPath().standardizedFileURL.path
            guard resolved.hasPrefix(root.path + "/") else { throw USBError("選択したUSBの外にはアクセスできません。") }
        }
        return current
    }

    private func coordinated<T>(_ url: URL, writing: Bool = false, _ action: (URL) throws -> T) throws -> T {
        try ensureConnected()
        var coordinationError: NSError?
        var result: Result<T, Error>?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        if writing {
            coordinator.coordinate(writingItemAt: url, options: .forMerging, error: &coordinationError) { item in
                result = Result { try checkedCoordinatedURL(item, expected: url); return try action(item) }
            }
        } else {
            coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { item in
                result = Result { try checkedCoordinatedURL(item, expected: url); return try action(item) }
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw USBError("USBのファイルを開けません。接続を確認してください。") }
        return try result.get()
    }

    private func checkedCoordinatedURL(_ actual: URL, expected: URL) throws {
        try ensureConnected()
        guard actual.standardizedFileURL == expected.standardizedFileURL else {
            throw USBError("操作中にUSBのファイルが移動されました。読み込み直してください。")
        }
    }

    /// Coordinating a plain directory alone does not lock its descendants.
    /// Acquire all live-file and read-only guard intents together so other
    /// coordinated writers cannot change one between validation and install.
    private func coordinatedFiles<T>(reading: [URL] = [], writing: [URL], _ action: @escaping () throws -> T) throws -> T {
        try ensureConnected()
        let intents = reading.map { NSFileAccessIntent.readingIntent(with: $0, options: []) } +
            writing.map { NSFileAccessIntent.writingIntent(with: $0, options: .forMerging) }
        let expected = reading + writing
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let completed = DispatchSemaphore(value: 0)
        var result: Result<T, Error>?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        coordinator.coordinate(with: intents, queue: queue) { error in
            defer { completed.signal() }
            result = Result {
                if let error { throw error }
                for (intent, url) in zip(intents, expected) { try self.checkedCoordinatedURL(intent.url, expected: url) }
                return try action()
            }
        }
        completed.wait()
        guard let result else { throw USBError("USBのファイルへのアクセスを開始できません。") }
        return try result.get()
    }

    private func hash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while let data = try handle.read(upToCount: Self.chunkLimit), !data.isEmpty { digest.update(data: data) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func metadata(_ url: URL, path: String, fingerprint: Bool) throws -> [String: Any] {
        let attributes = try manager.attributesOfItem(atPath: url.path)
        let type = attributes[.type] as? FileAttributeType
        guard type == .typeRegular || type == .typeDirectory else { throw USBError("通常のファイルとフォルダーのみ対応しています。") }
        var value: [String: Any] = ["exists": true, "path": path, "name": url.lastPathComponent,
            "kind": type == .typeDirectory ? "directory" : "file",
            "size": (attributes[.size] as? NSNumber)?.int64Value ?? 0,
            "modified": ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000]
        if fingerprint && type == .typeRegular { value["fingerprint"] = try hash(url) }
        else { value["fingerprint"] = NSNull() }
        return value
    }

    /// Cheap presence probe for reconnect polling. Never read/hash a database
    /// or walk audio folders on every poll.
    func libraryFormats() throws -> [String] {
        try coordinated(root) { _ in
            var formats = Set<String>()
            for base in ["PIONEER/rekordbox", ".PIONEER/rekordbox"] {
                for (name, format) in [("export.pdb", "pdb"), ("exportLibrary.db", "onelibrary")] {
                    let url = try safeURL(base + "/" + name)
                    if manager.fileExists(atPath: url.path),
                       (try manager.attributesOfItem(atPath: url.path))[.type] as? FileAttributeType == .typeRegular {
                        formats.insert(format)
                    }
                }
            }
            return ["pdb", "onelibrary"].filter { formats.contains($0) }
        }
    }

    func stat(_ path: String) throws -> [String: Any] {
        let url = try safeURL(path, allowEmpty: true)
        return try coordinated(manager.fileExists(atPath: url.path) ? url : root) { _ in
            guard manager.fileExists(atPath: url.path) else { return ["exists": false, "path": path, "fingerprint": NSNull()] }
            _ = try safeURL(path, allowEmpty: true)
            return try metadata(url, path: path, fingerprint: true)
        }
    }

    func list(_ path: String, recursive: Bool) throws -> [[String: Any]] {
        let folder = try safeURL(path, allowEmpty: true)
        return try coordinated(folder) { _ in
            var output: [[String: Any]] = []
            func visit(_ directory: URL) throws {
                for url in try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                    if url.lastPathComponent.lowercased() == Self.stagingName { continue }
                    let relative = String(url.path.dropFirst(root.path.count + 1))
                    let attributes = try manager.attributesOfItem(atPath: url.path)
                    if attributes[.type] as? FileAttributeType == .typeSymbolicLink { continue }
                    guard attributes[.type] as? FileAttributeType == .typeDirectory || attributes[.type] as? FileAttributeType == .typeRegular else { continue }
                    _ = try safeURL(relative)
                    output.append(try metadata(url, path: relative, fingerprint: false))
                    guard output.count <= 100_000 else { throw USBError("一度に読み込めるファイル数を超えました。フォルダーごとに開いてください。") }
                    if recursive && attributes[.type] as? FileAttributeType == .typeDirectory { try visit(url) }
                }
            }
            try visit(folder)
            return output
        }
    }

    func readRange(_ path: String, offset: Int64, length: Int) throws -> Data {
        guard offset >= 0, length >= 0, length <= Self.chunkLimit else { throw USBError("読み込み範囲が不正です。") }
        let url = try safeURL(path)
        return try coordinated(url) { _ in
            _ = try safeURL(path)
            guard (try manager.attributesOfItem(atPath: url.path))[.type] as? FileAttributeType == .typeRegular else { throw USBError("音源ファイルを選択してください。") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            return try handle.read(upToCount: length) ?? Data()
        }
    }

    private func journalURL(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw USBError("書き込みIDが不正です。") }
        return journalDirectory.appendingPathComponent(id + ".json")
    }
    private func load(_ id: String) throws -> Journal {
        let value = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: journalURL(id)))
        guard value.version == 1, value.id == id, value.rootID == rootID else { throw USBError("別のUSBの書き込み記録です。") }
        for write in value.writes { _ = try safeURL(write.path) }
        for guardItem in value.guards ?? [] { _ = try safeURL(guardItem.path) }
        return value
    }
    private func save(_ journal: Journal) throws {
        let target = try journalURL(journal.id)
        try JSONEncoder().encode(journal).write(to: target, options: .atomic)
        let handle = try FileHandle(forWritingTo: target)
        try handle.synchronize(); try handle.close()
    }
    private func transactionFolder(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw USBError("書き込みIDが不正です。") }
        return try safeURL(Self.stagingName + "/" + id, internalPath: true)
    }
    private func stagingFile(_ id: String, _ index: Int, old: Bool = false) throws -> URL {
        try safeURL(Self.stagingName + "/" + id + (old ? "/old/" : "/new/") + String(index), internalPath: true)
    }
    private func currentFingerprint(_ path: String) throws -> String? {
        let url = try safeURL(path)
        guard manager.fileExists(atPath: url.path) else { return nil }
        guard (try manager.attributesOfItem(atPath: url.path))[.type] as? FileAttributeType == .typeRegular else { throw USBError("書き込み先は通常のファイルではありません。") }
        return try hash(url)
    }

    private func verifyGuards(_ guards: [Guard]) throws {
        for guardItem in guards {
            guard try currentFingerprint(guardItem.path) == guardItem.expectedFingerprint else {
                throw USBError("USBのライブラリ構成が変更されています。読み込み直してください: \(guardItem.path)")
            }
        }
    }

    func begin(_ writes: [Write], guards: [Guard] = []) throws -> String {
        guard !writes.isEmpty, writes.count <= 50_000 else { throw USBError("書き込みファイル数が不正です。") }
        var names = Set<String>()
        for write in writes {
            _ = try safeURL(write.path)
            guard write.size >= 0, write.size <= 9_007_199_254_740_991,
                  write.expectedFingerprint == nil || (write.expectedFingerprint!.count == 64 && write.expectedFingerprint!.allSatisfy({ $0.isHexDigit })) else { throw USBError("ファイルサイズまたは変更確認値が不正です。") }
            let normalized = write.path.precomposedStringWithCanonicalMapping.lowercased()
            guard names.insert(normalized).inserted else { throw USBError("同じ書き込み先が重複しています。") }
        }
        guard guards.count <= 50_000 else { throw USBError("変更確認ファイル数が多すぎます。") }
        for guardItem in guards {
            _ = try safeURL(guardItem.path)
            guard !names.contains(guardItem.path.precomposedStringWithCanonicalMapping.lowercased()),
                  guardItem.expectedFingerprint == nil || (guardItem.expectedFingerprint!.count == 64 && guardItem.expectedFingerprint!.allSatisfy({ $0.isHexDigit })) else { throw USBError("読み取り専用の変更確認値が不正、または書き込み先と重複しています。") }
        }
        for name in names {
            let parts = name.split(separator: "/")
            for count in 1..<parts.count {
                guard !names.contains(parts.prefix(count).joined(separator: "/")) else { throw USBError("ファイルとフォルダーのパスが競合しています。") }
            }
        }
        // An interrupted transaction must be recovered before another can begin.
        guard try pendingJournals().isEmpty else { throw USBError("未完了のUSB書き込みがあります。先に復旧してください。") }
        let readURLs = try (writes.map(\.path) + guards.map(\.path)).map { try safeURL($0) }
        return try coordinatedFiles(reading: readURLs, writing: [root]) { [self] in
            try verifyGuards(guards)
            for write in writes {
                guard try currentFingerprint(write.path) == write.expectedFingerprint else { throw USBError("USB上のファイルが変更されています。ライブラリを読み込み直してください: \(write.path)") }
            }
            let id = UUID().uuidString
            let journal = Journal(version: 1, id: id, rootID: rootID, state: "staging", writes: writes, guards: guards)
            try save(journal)
            do {
                try manager.createDirectory(at: transactionFolder(id).appendingPathComponent("new"), withIntermediateDirectories: true)
                try manager.createDirectory(at: transactionFolder(id).appendingPathComponent("old"), withIntermediateDirectories: true)
                for index in writes.indices {
                    guard manager.createFile(atPath: try stagingFile(id, index).path, contents: Data()) else { throw USBError("USBに作業用ファイルを作成できません。空き容量を確認してください。") }
                }
            } catch { try? cleanup(journal); throw error }
            return id
        }
    }

    func writeChunk(_ id: String, path: String, offset: Int64, data: Data) throws {
        let journal = try load(id)
        guard journal.state == "staging", data.count <= Self.chunkLimit,
              let index = journal.writes.firstIndex(where: { $0.path == path }), offset >= 0,
              offset <= journal.writes[index].size, Int64(data.count) <= journal.writes[index].size - offset else { throw USBError("書き込み範囲が不正です。") }
        let target = try stagingFile(id, index)
        try coordinated(target, writing: true) { _ in
            let size = (try manager.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? -1
            guard offset == size else { throw USBError("書き込み順序が一致しません。処理をやり直してください。") }
            let handle = try FileHandle(forWritingTo: target)
            defer { try? handle.close() }
            try handle.seekToEnd(); try handle.write(contentsOf: data)
            if offset + Int64(data.count) == journal.writes[index].size { try handle.synchronize() }
        }
    }

    func commit(_ id: String) throws -> [String: Any] {
        var journal = try load(id)
        guard journal.state == "staging" else { throw USBError("書き込みは既に開始されています。復旧処理を実行してください。") }
        let readURLs = try (journal.guards ?? []).map { try safeURL($0.path) }
        let writeURLs = try journal.writes.map { try safeURL($0.path) }
        return try coordinatedFiles(reading: readURLs, writing: [root] + writeURLs) { [self] in
            // Finish every verification before the first live file is touched.
            try verifyGuards(journal.guards ?? [])
            for index in journal.writes.indices {
                let staged = try stagingFile(id, index)
                let size = (try manager.attributesOfItem(atPath: staged.path)[.size] as? NSNumber)?.int64Value ?? -1
                guard size == journal.writes[index].size else { throw USBError("書き込みデータが揃っていません。元のUSBファイルは変更していません。") }
                guard try currentFingerprint(journal.writes[index].path) == journal.writes[index].expectedFingerprint else { throw USBError("USB上のファイルが変更されています。読み込み直してください。") }
                journal.writes[index].fingerprint = try hash(staged)
            }
            journal.state = "committing"; try save(journal)
            do {
                // Caller orders analysis/audio first and the database last.
                for index in journal.writes.indices {
                    try ensureConnected()
                    try verifyGuards(journal.guards ?? [])
                    let write = journal.writes[index]
                    let target = try safeURL(write.path)
                    guard try currentFingerprint(write.path) == write.expectedFingerprint else { throw USBError("書き込み中にUSBのファイルが変更されました。") }
                    if write.expectedFingerprint != nil {
                        let backup = try stagingFile(id, index, old: true)
                        try manager.copyItem(at: target, to: backup)
                        guard try hash(backup) == write.expectedFingerprint else { throw USBError("バックアップを確認できません。") }
                        let handle = try FileHandle(forWritingTo: backup); try handle.synchronize(); try handle.close()
                    }
                    journal.writes[index].phase = "installing"; try save(journal)
                    try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    _ = try safeURL(write.path)
                    let staged = try stagingFile(id, index)
                    if manager.fileExists(atPath: target.path) {
                        _ = try manager.replaceItemAt(target, withItemAt: staged, backupItemName: nil, options: [])
                    } else { try manager.moveItem(at: staged, to: target) }
                    guard try hash(target) == write.fingerprint else { throw USBError("書き込んだファイルの検証に失敗しました。") }
                    journal.writes[index].phase = "applied"; try save(journal)
                    try afterInstall?(index)
                }
                try ensureConnected()
                journal.state = "committed"; try save(journal)
            } catch {
                do { try rollbackContents(&journal) }
                catch { throw USBError("USBの書き込みが中断され、復旧が必要です。同じUSBを接続して「復旧」を実行してください。元のバックアップは保持しています。\n\(error.localizedDescription)") }
                throw error
            }
            var cleanupPending = false
            do { try cleanup(journal) } catch { cleanupPending = true }
            return ["id": id, "written": journal.writes.count, "cleanupPending": cleanupPending]
        }
    }

    private func rollbackContents(_ journal: inout Journal) throws {
        for index in journal.writes.indices.reversed() {
            try ensureConnected()
            let write = journal.writes[index]
            guard write.phase == "installing" || write.phase == "applied" else { continue }
            let current = try currentFingerprint(write.path)
            if current == write.expectedFingerprint { journal.writes[index].phase = "restored"; try save(journal); continue }
            guard current == write.fingerprint || current == nil else { throw USBError("復旧先に別の変更があります。バックアップを保持しました: \(write.path)") }
            let target = try safeURL(write.path)
            if let expected = write.expectedFingerprint {
                let backup = try stagingFile(journal.id, index, old: true)
                guard try hash(backup) == expected else { throw USBError("復旧用バックアップを確認できません。") }
                let restore = try transactionFolder(journal.id).appendingPathComponent("restore-\(index)")
                if manager.fileExists(atPath: restore.path) { try manager.removeItem(at: restore) }
                try manager.copyItem(at: backup, to: restore)
                if manager.fileExists(atPath: target.path) { _ = try manager.replaceItemAt(target, withItemAt: restore, backupItemName: nil, options: []) }
                else { try manager.moveItem(at: restore, to: target) }
                guard try hash(target) == expected else { throw USBError("復旧ファイルを検証できません。") }
            } else if current != nil { try manager.removeItem(at: target) }
            journal.writes[index].phase = "restored"; try save(journal)
        }
        journal.state = "rolledBack"; try save(journal)
        try cleanup(journal)
    }

    private func cleanup(_ journal: Journal) throws {
        try ensureConnected()
        let folder = try transactionFolder(journal.id)
        if manager.fileExists(atPath: folder.path) { try manager.removeItem(at: folder) }
        let record = try journalURL(journal.id)
        if manager.fileExists(atPath: record.path) { try manager.removeItem(at: record) }
    }

    func rollback(_ id: String) throws {
        guard manager.fileExists(atPath: try journalURL(id).path) else { return }
        var journal = try load(id)
        let writeURLs = try journal.writes.map { try safeURL($0.path) }
        try coordinatedFiles(writing: [root] + writeURLs) { [self] in
            if journal.state == "committed" || journal.state == "rolledBack" { try cleanup(journal) }
            else { try rollbackContents(&journal) }
        }
    }

    func pendingJournals() throws -> [String] {
        try manager.contentsOfDirectory(at: journalDirectory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.compactMap { url in
            let journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: url))
            return journal.rootID == rootID ? journal.id : nil
        }
    }

    func recover() throws -> Int {
        let ids = try pendingJournals()
        for id in ids { try rollback(id) }
        return ids.count
    }
}

import Foundation
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Folder access is granted only by the system picker, never by a JavaScript
/// path. NSFileCoordinator and security scopes stay on one background queue.
final class NativeUSB: NSObject, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    weak var webView: WKWebView?
    private let origin: URL
    private let queue = DispatchQueue(label: "com.bassmicrobe.deckflow.usb", qos: .userInitiated)
    private let defaults: UserDefaults
    private let journalDirectory: URL
    private var pickerReply: ((Any?, String?) -> Void)?
    private let recordKey = "deckflow.usb.bookmarks.v1"

    private struct DirectoryRecord: Codable {
        let id: String
        let name: String
        var bookmark: Data
        let identity: String
    }

    init(origin: URL, defaults: UserDefaults = .standard) {
        self.origin = origin; self.defaults = defaults
        self.journalDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("USBTransactions", isDirectory: true)
        super.init()
    }

    static func allows(_ security: WKSecurityOrigin, mainFrame: Bool, current: URL?, origin: URL) -> Bool {
        guard mainFrame, let current else { return false }
        return security.protocol == origin.scheme && security.host == origin.host && security.port == origin.port &&
            current.scheme == origin.scheme && current.host == origin.host && current.port == origin.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard Self.allows(message.frameInfo.securityOrigin, mainFrame: message.frameInfo.isMainFrame, current: webView?.url, origin: origin),
              let body = message.body as? [String: Any], let command = body["command"] as? String else {
            replyHandler(nil, "この画面からUSBへアクセスできません。"); return
        }
        if command == "chooseDirectory" {
            DispatchQueue.main.async { [weak self] in self?.choose(replyHandler) }
            return
        }
        queue.async { [self] in
            do {
                let result: Any = try perform(command, body)
                DispatchQueue.main.async { replyHandler(result, nil) }
            } catch {
                DispatchQueue.main.async { replyHandler(nil, "USB操作を完了できませんでした。接続を確認してください。\n\(error.localizedDescription)") }
            }
        }
    }

    private func records() throws -> [DirectoryRecord] {
        guard let data = defaults.data(forKey: recordKey) else { return [] }
        return try JSONDecoder().decode([DirectoryRecord].self, from: data)
    }
    private func saveRecords(_ records: [DirectoryRecord]) throws { defaults.set(try JSONEncoder().encode(records), forKey: recordKey) }
    private func identity(_ url: URL) throws -> String {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .volumeUUIDStringKey])
        guard values.isDirectory == true else { throw USBError("USBのルートフォルダーを選択してください。") }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let inode = attributes[.systemFileNumber] as? NSNumber else { throw USBError("このフォルダーの識別情報を読み込めません。") }
        return (values.volumeUUIDString ?? (attributes[.systemNumber] as? NSNumber)?.stringValue ?? url.path) + ":" + inode.stringValue
    }

    private func register(_ url: URL) throws -> [String: Any] {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let fingerprint = try identity(url)
        var all = try records()
        let index = all.firstIndex { $0.identity == fingerprint }
        let record = DirectoryRecord(id: index.map { all[$0].id } ?? UUID().uuidString, name: url.lastPathComponent,
            bookmark: try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil), identity: fingerprint)
        if let index { all[index] = record } else { all.append(record) }
        try saveRecords(all)
        let store = try NativeUSBStore(root: url, rootID: record.id, journalDirectory: journalDirectory)
        return ["id": record.id, "name": record.name, "pendingTransactions": try store.pendingJournals().count]
    }

    private func withRoot<T>(_ id: String, _ action: (NativeUSBStore, DirectoryRecord) throws -> T) throws -> T {
        var all = try records()
        guard let index = all.firstIndex(where: { $0.id == id }) else { throw USBError("システムのフォルダー選択からUSBを開いてください。") }
        var stale = false
        let url = try URL(resolvingBookmarkData: all[index].bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale)
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard try identity(url) == all[index].identity else { throw USBError("保存したUSBと一致しません。同じUSBを接続して選び直してください。") }
        if stale {
            all[index].bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            try saveRecords(all)
        }
        return try action(NativeUSBStore(root: url, rootID: id, journalDirectory: journalDirectory), all[index])
    }

    private func string(_ body: [String: Any], _ key: String) throws -> String {
        guard let value = body[key] as? String else { throw USBError("USB操作の引数が不正です: \(key)") }
        return value
    }
    private func integer(_ body: [String: Any], _ key: String) throws -> Int64 {
        guard let number = body[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue.rounded(.towardZero) == number.doubleValue else { throw USBError("USB操作の数値が不正です: \(key)") }
        return number.int64Value
    }

    private func perform(_ command: String, _ body: [String: Any]) throws -> Any {
        // Resolve only folders the user has already authorized. Each bookmark
        // is independent: an unplugged device must not hide other devices.
        if command == "listDevices" {
            return try records().map { record -> [String: Any] in
                do {
                    return try withRoot(record.id) { store, current in
                        ["id": current.id, "name": current.name, "connected": true,
                         "libraryFormats": try store.libraryFormats(),
                         "pendingTransactions": try store.pendingJournals().count]
                    }
                } catch {
                    return ["id": record.id, "name": record.name, "connected": false,
                            "libraryFormats": [], "pendingTransactions": 0]
                }
            }
        }
        let id = try string(body, "rootId")
        return try withRoot(id) { store, record in
            switch command {
            case "restoreDirectory": return ["id": record.id, "name": record.name, "pendingTransactions": try store.pendingJournals().count]
            case "list": return try store.list(body["path"] as? String ?? "", recursive: body["recursive"] as? Bool ?? true)
            case "stat": return try store.stat(string(body, "path"))
            case "readRange":
                let length = try integer(body, "length")
                guard length <= NativeUSBStore.chunkLimit else { throw USBError("一度の読み込みは1 MiBまでです。") }
                return ["data": try store.readRange(string(body, "path"), offset: integer(body, "offset"), length: Int(length)).base64EncodedString()]
            case "beginTransaction":
                guard let raw = body["writes"] as? [[String: Any]] else { throw USBError("書き込み一覧が不正です。") }
                let writes = try raw.map { item -> NativeUSBStore.Write in
                    guard item.keys.contains("expectedFingerprint"), item["expectedFingerprint"] is NSNull || item["expectedFingerprint"] is String else { throw USBError("変更確認値がありません。") }
                    return NativeUSBStore.Write(path: try string(item, "path"), size: try integer(item, "size"), expectedFingerprint: item["expectedFingerprint"] as? String)
                }
                guard body["guards"] == nil || body["guards"] is [[String: Any]] else { throw USBError("読み取り専用の変更確認一覧が不正です。") }
                let guards = try (body["guards"] as? [[String: Any]] ?? []).map { item -> NativeUSBStore.Guard in
                    guard item.keys.contains("expectedFingerprint"), item["expectedFingerprint"] is NSNull || item["expectedFingerprint"] is String else { throw USBError("読み取り専用の変更確認値がありません。") }
                    return NativeUSBStore.Guard(path: try string(item, "path"), expectedFingerprint: item["expectedFingerprint"] as? String)
                }
                return ["id": try store.begin(writes, guards: guards)]
            case "writeChunk":
                let encoded = try string(body, "data")
                guard encoded.utf8.count <= (NativeUSBStore.chunkLimit + 2) / 3 * 4,
                      let data = Data(base64Encoded: encoded) else { throw USBError("書き込みデータが不正です。") }
                try store.writeChunk(string(body, "transactionId"), path: string(body, "path"), offset: integer(body, "offset"), data: data)
                return ["written": data.count]
            case "commitTransaction": return try store.commit(string(body, "transactionId"))
            case "rollbackTransaction": try store.rollback(string(body, "transactionId")); return ["restored": true]
            case "recover": return ["recovered": try store.recover()]
            default: throw USBError("未対応のUSB操作です。")
            }
        }
    }

    private func choose(_ reply: @escaping (Any?, String?) -> Void) {
        guard pickerReply == nil, var presenter = webView?.window?.rootViewController else { reply(nil, "フォルダー選択を開始できません。"); return }
        while let next = presenter.presentedViewController { presenter = next }
        guard !(presenter is UIDocumentPickerViewController) else { reply(nil, "フォルダー選択が既に開いています。"); return }
        pickerReply = reply
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = self
        presenter.present(picker, animated: true)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let reply = pickerReply; pickerReply = nil
        reply?(nil, "フォルダー選択をキャンセルしました。")
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let reply = pickerReply else { return }
        pickerReply = nil
        guard urls.count == 1, let url = urls.first else { reply(nil, "USBのフォルダーを1つ選択してください。"); return }
        queue.async { [self] in
            do { let result = try register(url); DispatchQueue.main.async { reply(result, nil) } }
            catch { DispatchQueue.main.async { reply(nil, error.localizedDescription) } }
        }
    }
}

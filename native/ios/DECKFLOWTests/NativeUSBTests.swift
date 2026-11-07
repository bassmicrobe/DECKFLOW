import XCTest
import CryptoKit
@testable import DECKFLOW

final class NativeUSBTests: XCTestCase {
    private var temporary: URL!
    private var root: URL!
    private var journals: URL!
    private var store: NativeUSBStore!
    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent("deckflow-usb-test-" + UUID().uuidString)
        root = temporary.appendingPathComponent("selected")
        journals = temporary.appendingPathComponent("private-journals")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = try NativeUSBStore(root: root, rootID: "test-root", journalDirectory: journals)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: temporary) }
    private func put(_ path: String, _ text: String) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }
    private func text(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }
    private func fingerprint(_ path: String) throws -> String { try XCTUnwrap(store.stat(path)["fingerprint"] as? String) }
    private func stage(_ writes: [(String, String, String?)]) throws -> String {
        let id = try store.begin(writes.map { .init(path: $0.0, size: Int64($0.1.utf8.count), expectedFingerprint: $0.2) })
        for (path, value, _) in writes { try store.writeChunk(id, path: path, offset: 0, data: Data(value.utf8)) }
        return id
    }

    func testDeviceFormatProbeFindsBothLibrariesWithoutScanningContents() throws {
        XCTAssertEqual(try store.libraryFormats(), [])
        try put("PIONEER/rekordbox/export.pdb", "pdb")
        XCTAssertEqual(try store.libraryFormats(), ["pdb"])
        try put("PIONEER/rekordbox/exportLibrary.db", "one")
        XCTAssertEqual(try store.libraryFormats(), ["pdb", "onelibrary"])
        try FileManager.default.removeItem(at: root.appendingPathComponent("PIONEER/rekordbox/exportLibrary.db"))
        try put(".PIONEER/rekordbox/exportLibrary.db", "one")
        XCTAssertEqual(try store.libraryFormats(), ["pdb", "onelibrary"])
        try FileManager.default.removeItem(at: root)
        XCTAssertThrowsError(try store.libraryFormats())
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func testInventoryRangeAndHashDoNotEscapeSelectedRoot() throws {
        try put("PIONEER/rekordbox/export.pdb", "123456789")
        try put("Contents/日本語.wav", "abcdefghijk")
        let listing = try store.list("", recursive: true)
        XCTAssertEqual(listing.filter { $0["kind"] as? String == "file" }.count, 2)
        let stat = try store.stat("Contents/日本語.wav")
        XCTAssertEqual(stat["size"] as? Int64, 11)
        XCTAssertGreaterThan(stat["modified"] as? Double ?? 0, 1_000_000_000_000)
        XCTAssertEqual(try store.readRange("Contents/日本語.wav", offset: 3, length: 4), Data("defg".utf8))
        XCTAssertEqual(try store.readRange("Contents/日本語.wav", offset: 20, length: 10), Data())
        XCTAssertEqual(try fingerprint("PIONEER/rekordbox/export.pdb"), SHA256.hash(data: Data("123456789".utf8)).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(try store.stat("missing")["exists"] as? Bool, false)
        for path in ["../outside", "/absolute", "a/../outside", "a\\b", "a//b", "a\u{0}b", ".deckflow-transactions/x", ".DECKFLOW-TRANSACTIONS/x"] { XCTAssertThrowsError(try store.safeURL(path), path) }
        XCTAssertThrowsError(try store.readRange("Contents/日本語.wav", offset: -1, length: 1))
        XCTAssertThrowsError(try store.readRange("Contents/日本語.wav", offset: 0, length: NativeUSBStore.chunkLimit + 1))
        let outside = temporary.appendingPathComponent("outside")
        try Data("private".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link"), withDestinationURL: outside)
        XCTAssertThrowsError(try store.readRange("link", offset: 0, length: 7))
        XCTAssertFalse(try store.list("", recursive: true).contains { $0["path"] as? String == "link" })
    }

    func testBatchStagesBeforeReplacingAndCommitsInCallerOrder() throws {
        try put("PIONEER/rekordbox/export.pdb", "old database")
        let before = try fingerprint("PIONEER/rekordbox/export.pdb")
        let id = try stage([("Contents/new.wav", "new audio", nil), ("PIONEER/ANLZ/new.DAT", "new analysis", nil), ("PIONEER/rekordbox/export.pdb", "new database", before)])
        XCTAssertEqual(try text("PIONEER/rekordbox/export.pdb"), "old database")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Contents/new.wav").path))
        var installed: [Int] = []
        store.afterInstall = { installed.append($0) }
        let result = try store.commit(id)
        XCTAssertEqual(installed, [0, 1, 2])
        XCTAssertEqual(result["written"] as? Int, 3)
        XCTAssertEqual(try text("PIONEER/rekordbox/export.pdb"), "new database")
        XCTAssertEqual(try text("Contents/new.wav"), "new audio")
        XCTAssertTrue(try store.pendingJournals().isEmpty)
        XCTAssertNoThrow(try store.rollback(id), "Rollback is idempotent after native commit already cleaned up")
    }

    func testFingerprintConflictAndIncompleteStagingNeverTouchLiveFiles() throws {
        try put("library.db", "old")
        let before = try fingerprint("library.db")
        XCTAssertThrowsError(try store.begin([.init(path: "library.db", size: 1, expectedFingerprint: nil)]))
        let id = try store.begin([.init(path: "library.db", size: 5, expectedFingerprint: before)])
        try store.writeChunk(id, path: "library.db", offset: 0, data: Data("new".utf8))
        XCTAssertThrowsError(try store.commit(id))
        XCTAssertEqual(try text("library.db"), "old")
        XCTAssertThrowsError(try store.writeChunk(id, path: "library.db", offset: 0, data: Data("no".utf8)))
        try store.rollback(id)
        let changed = try stage([("library.db", "replacement", before)])
        try put("library.db", "external edit")
        XCTAssertThrowsError(try store.commit(changed))
        XCTAssertEqual(try text("library.db"), "external edit")
        try store.rollback(changed)
    }

    func testFailureAfterFirstReplacementRestoresEveryOriginal() throws {
        try put("first.db", "original first")
        try put("last.db", "original last")
        let id = try stage([("first.db", "changed first", fingerprint("first.db")), ("new.wav", "created", nil), ("last.db", "changed last", fingerprint("last.db"))])
        store.afterInstall = { if $0 == 1 { throw USBError("Simulated I/O failure") } }
        XCTAssertThrowsError(try store.commit(id))
        XCTAssertEqual(try text("first.db"), "original first")
        XCTAssertEqual(try text("last.db"), "original last")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("new.wav").path))
        XCTAssertTrue(try store.pendingJournals().isEmpty)
    }

    func testReconnectRecoversPrivateJournalAndBackupAfterInterruptedWrite() throws {
        try put("library.db", "original")
        let before = try fingerprint("library.db")
        let id = try stage([("library.db", "replacement", before)])
        let detached = temporary.appendingPathComponent("detached")
        store.afterInstall = { _ in try FileManager.default.moveItem(at: self.root, to: detached) }
        XCTAssertThrowsError(try store.commit(id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: journals.appendingPathComponent(id + ".json").path))
        try FileManager.default.moveItem(at: detached, to: root)
        let reconnected = try NativeUSBStore(root: root, rootID: "test-root", journalDirectory: journals)
        XCTAssertEqual(try reconnected.recover(), 1)
        XCTAssertEqual(try text("library.db"), "original")
        XCTAssertTrue(try reconnected.pendingJournals().isEmpty)
    }

    func testRecoveryPreservesExternalChangesAndBackup() throws {
        try put("library.db", "original")
        let id = try stage([("library.db", "replacement", fingerprint("library.db"))])
        store.afterInstall = { _ in try self.put("library.db", "external edit"); throw USBError("Simulated concurrent edit") }
        XCTAssertThrowsError(try store.commit(id))
        XCTAssertEqual(try text("library.db"), "external edit")
        XCTAssertThrowsError(try store.recover())
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(".deckflow-transactions/\(id)/old/0").path))
        XCTAssertThrowsError(try store.begin([.init(path: "another", size: 1, expectedFingerprint: nil)]))
    }

    func testReadOnlyGuardsDetectDatabaseChangesAndNewOneLibraryBeforeMutation() throws {
        try put("export.pdb", "original database")
        try put("cue.DAT", "original cue")
        let guards: [NativeUSBStore.Guard] = [.init(path: "export.pdb", expectedFingerprint: try fingerprint("export.pdb")), .init(path: "exportLibrary.db", expectedFingerprint: nil)]
        let writes: [NativeUSBStore.Write] = [.init(path: "cue.DAT", size: 3, expectedFingerprint: try fingerprint("cue.DAT"))]
        let id = try store.begin(writes, guards: guards)
        try store.writeChunk(id, path: "cue.DAT", offset: 0, data: Data("new".utf8))
        try put("exportLibrary.db", "external OneLibrary")
        XCTAssertThrowsError(try store.commit(id))
        XCTAssertEqual(try text("cue.DAT"), "original cue")
        try store.rollback(id)
        XCTAssertThrowsError(try store.begin(writes, guards: guards))
    }

    func testReadOnlyGuardChangeDuringCommitRollsBackInstalledFiles() throws {
        let guards: [NativeUSBStore.Guard] = [.init(path: "exportLibrary.db", expectedFingerprint: nil)]
        let writes: [NativeUSBStore.Write] = [.init(path: "first", size: 3, expectedFingerprint: nil), .init(path: "second", size: 3, expectedFingerprint: nil)]
        let id = try store.begin(writes, guards: guards)
        for path in ["first", "second"] { try store.writeChunk(id, path: path, offset: 0, data: Data("new".utf8)) }
        store.afterInstall = { _ in try self.put("exportLibrary.db", "external") }
        XCTAssertThrowsError(try store.commit(id))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("first").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("second").path))
        XCTAssertEqual(try text("exportLibrary.db"), "external")
    }

    func testDuplicatePathsAncestorConflictsAndSelectedVolumeReplacementAreRejected() throws {
        XCTAssertThrowsError(try store.begin([.init(path: "A.db", size: 0, expectedFingerprint: nil), .init(path: "a.db", size: 0, expectedFingerprint: nil)]))
        XCTAssertThrowsError(try store.begin([.init(path: "a", size: 0, expectedFingerprint: nil), .init(path: "a/b", size: 0, expectedFingerprint: nil)]))
        try FileManager.default.moveItem(at: root, to: temporary.appendingPathComponent("old-volume"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.list("", recursive: true))
    }

    func testCoordinatedGuardWriterWaitsUntilBatchCompletes() throws {
        try put("export.pdb", "original database")
        let guardURL = root.appendingPathComponent("export.pdb")
        let guards: [NativeUSBStore.Guard] = [.init(path: "export.pdb", expectedFingerprint: try fingerprint("export.pdb"))]
        let id = try store.begin([.init(path: "first.DAT", size: 3, expectedFingerprint: nil), .init(path: "second.DAT", size: 3, expectedFingerprint: nil)], guards: guards)
        for path in ["first.DAT", "second.DAT"] { try store.writeChunk(id, path: path, offset: 0, data: Data("new".utf8)) }
        let started = DispatchSemaphore(value: 0)
        let entered = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        store.afterInstall = { index in
            guard index == 0 else { return }
            DispatchQueue.global().async {
                var coordinationError: NSError?
                let coordinator = NSFileCoordinator(filePresenter: nil)
                started.signal()
                coordinator.coordinate(writingItemAt: guardURL, options: .forMerging, error: &coordinationError) { url in
                    entered.signal()
                    do { try Data("external edit".utf8).write(to: url) }
                    catch { XCTFail(error.localizedDescription) }
                }
                XCTAssertNil(coordinationError)
                finished.signal()
            }
            XCTAssertEqual(started.wait(timeout: .now() + 3), .success)
            XCTAssertEqual(entered.wait(timeout: .now() + 0.1), .timedOut, "The guard must remain locked until all writes finish")
        }
        XCTAssertNoThrow(try store.commit(id))
        XCTAssertEqual(finished.wait(timeout: .now() + 3), .success)
        XCTAssertEqual(try text("export.pdb"), "external edit")
        XCTAssertEqual(try text("second.DAT"), "new")
    }
}

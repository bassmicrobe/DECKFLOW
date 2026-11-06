import XCTest
import WebKit
@testable import DECKFLOW

final class NativeRuntimeTests: XCTestCase {
    func testAssetPathsCannotEscapeBundle() throws {
        let root = URL(fileURLWithPath: "/tmp/deckflow-web", isDirectory: true)
        XCTAssertEqual(LocalAssetServer.assetURL(target: "/", root: root)?.lastPathComponent, "index.html")
        XCTAssertEqual(LocalAssetServer.assetURL(target: "/vendor/soundtouch/worklet.js?v=1", root: root)?.path, "/tmp/deckflow-web/vendor/soundtouch/worklet.js")
        XCTAssertEqual(LocalAssetServer.assetURL(target: "/vendor/soundtouchjs/packages/audio-worklet/.dist/SoundTouchNode.js", root: root)?.lastPathComponent, "SoundTouchNode.js")
        for target in ["/../secret", "/%2e%2e/secret", "/.hidden", "/x/../secret", "//example.com/a", "https://example.com", "/x\\secret", "/%00secret", "/.dist/secret", "/vendor/soundtouchjs/packages/unknown/.dist/private.js"] {
            XCTAssertNil(LocalAssetServer.assetURL(target: target, root: root), target)
        }
    }

    func testMIDIFramerKeepsRunningStatusAndExcludesSysEx() {
        var framer = MIDIMessageFramer()
        XCTAssertEqual(framer.append([0x90, 60]), [])
        XCTAssertEqual(framer.append([127, 61, 0, 0xF8, 0xB0, 7, 100]), [[0x90, 60, 127], [0x90, 61, 0], [0xB0, 7, 100]])
        XCTAssertEqual(framer.append([0xF0, 1, 2, 3, 0xF7, 1, 2, 0xE1, 0, 64]), [[0xE1, 0, 64]])
    }

    @MainActor
    func testLoopbackOriginAllowsAudioWorkletAndNativeMIDIShim() async throws {
        let root = try XCTUnwrap(Bundle.main.url(forResource: "Web", withExtension: nil))
        let server = LocalAssetServer(port: 49038)
        defer { server.stop() }
        let url = try await server.start(root: root)
        let configuration = WKWebViewConfiguration()
        let scriptURL = try XCTUnwrap(Bundle.main.url(forResource: "NativeMIDIBridge", withExtension: "js"))
        let script = try String(contentsOf: scriptURL, encoding: .utf8)
        configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let model = AppModel()
        let coordinator = DeckWebView.Coordinator(origin: url, model: model)
        configuration.userContentController.add(coordinator, name: "deckflowMIDI")
        defer {
            configuration.userContentController.removeScriptMessageHandler(forName: "deckflowMIDI")
            coordinator.midi.stop()
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        coordinator.webView = webView
        let loaded = expectation(description: "localhost page loaded")
        let delegate = NavigationObserver(loaded)
        webView.navigationDelegate = delegate
        webView.load(URLRequest(url: url))
        await fulfillment(of: [loaded], timeout: 20)
        let appResult = try await webView.callAsyncJavaScript("""
          const deadline = Date.now() + 10000;
          while ((!document.querySelector('#a-platter') || !document.querySelector('#mapping-list tr')) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return {platter: !!document.querySelector('#a-platter'), mappingRows: document.querySelectorAll('#mapping-list tr').length, startupFailure: document.querySelector('#library-status')?.textContent.includes('起動できませんでした') ?? false};
          """, arguments: [:], in: nil, contentWorld: .page)
        let appValues = try XCTUnwrap(appResult as? [String: Any])
        XCTAssertEqual(appValues["platter"] as? Bool, true, "Bundled app.js must render the actual deck UI")
        XCTAssertGreaterThan(appValues["mappingRows"] as? Int ?? 0, 10, "Bundled app.js must render input assignments")
        XCTAssertEqual(appValues["startupFailure"] as? Bool, false)
        let result = try await webView.callAsyncJavaScript("""
          const context = new AudioContext();
          const moduleURL = URL.createObjectURL(new Blob(["registerProcessor('deckflow-smoke', class extends AudioWorkletProcessor { process() { return true; } });"], {type: 'text/javascript'}));
          await context.audioWorklet.addModule(moduleURL);
          const node = new AudioWorkletNode(context, 'deckflow-smoke');
          node.disconnect(); await context.close(); URL.revokeObjectURL(moduleURL);
          return {secure: window.isSecureContext, worklet: true, midi: typeof navigator.requestMIDIAccess, platform: window.DECKFLOW_NATIVE.platform};
          """, arguments: [:], in: nil, contentWorld: .page)
        let values = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(values["secure"] as? Bool, true)
        XCTAssertEqual(values["worklet"] as? Bool, true)
        XCTAssertEqual(values["midi"] as? String, "function")
        XCTAssertEqual(values["platform"] as? String, "ios")
        XCTAssertFalse(coordinator.midi.enabled, "MIDI must not start automatically while the page loads")
        let midiResult = try await webView.callAsyncJavaScript("""
          const access = await navigator.requestMIDIAccess({sysex: false});
          return {inputs: access.inputs instanceof Map, outputs: access.outputs.size, sysex: access.sysexEnabled};
          """, arguments: [:], in: nil, contentWorld: .page)
        let midiValues = try XCTUnwrap(midiResult as? [String: Any])
        XCTAssertEqual(midiValues["inputs"] as? Bool, true)
        XCTAssertEqual(midiValues["outputs"] as? Int, 0)
        XCTAssertEqual(midiValues["sysex"] as? Bool, false)
        XCTAssertTrue(coordinator.midi.enabled, "An explicit access request must reach CoreMIDI through the native bridge")

        let vendorResult = try await webView.callAsyncJavaScript("""
          const base = './vendor/soundtouchjs/packages/audio-worklet/.dist/';
          const responses = await Promise.all(['SoundTouchNode.js', 'soundtouch-processor.js'].map(name => fetch(base + name)));
          if (!responses.every(response => response.ok)) return {fetch: false, worklet: false};
          const {SoundTouchNode} = await import(base + 'SoundTouchNode.js');
          const context = new AudioContext();
          await SoundTouchNode.register(context, new URL(base + 'soundtouch-processor.js', location.href));
          const node = new SoundTouchNode({context, outputChannelCount: 2});
          node.disconnect(); await context.close();
          return {fetch: true, worklet: true};
          """, arguments: [:], in: nil, contentWorld: .page)
        let vendorValues = try XCTUnwrap(vendorResult as? [String: Any])
        XCTAssertEqual(vendorValues["fetch"] as? Bool, true)
        XCTAssertEqual(vendorValues["worklet"] as? Bool, true, "Pinned SoundTouch modules must register from the actual localhost bundle")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 405)
    }
}

@MainActor
private final class NavigationObserver: NSObject, WKNavigationDelegate {
    let expectation: XCTestExpectation
    init(_ expectation: XCTestExpectation) { self.expectation = expectation }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { expectation.fulfill() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        XCTFail(error.localizedDescription); expectation.fulfill()
    }
}

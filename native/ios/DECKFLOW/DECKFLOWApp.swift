import SwiftUI
import WebKit

@main
struct DECKFLOWApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            ZStack {
                Color(red: 17 / 255, green: 20 / 255, blue: 22 / 255).ignoresSafeArea()
                if let url = model.url {
                    DeckWebView(url: url, model: model).ignoresSafeArea(edges: .bottom)
                } else if let error = model.error {
                    VStack(spacing: 18) {
                        Text("DECKFLOW").font(.largeTitle.bold())
                        Text(error).multilineTextAlignment(.center)
                        Button("再試行") { Task { await model.start() } }.buttonStyle(.borderedProminent)
                    }.padding(30).foregroundStyle(.white)
                } else {
                    VStack(spacing: 18) { Text("DECKFLOW").font(.largeTitle.bold()); ProgressView() }.foregroundStyle(.white)
                }
            }
            .preferredColorScheme(.dark)
            .task { await model.start() }
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var url: URL?
    @Published var error: String?
    let server = LocalAssetServer()
    private var starting = false

    func start() async {
        guard url == nil, !starting else { return }
        starting = true; error = nil
        defer { starting = false }
        guard let root = Bundle.main.url(forResource: "Web", withExtension: nil) else {
            error = "Webの同梱ファイルがありません。リポジトリで node scripts/sync-ios-assets.mjs を実行してからビルドしてください。"
            return
        }
        do { url = try await server.start(root: root) }
        catch { self.error = "同梱サーバーを開始できません。アプリを終了して再試行してください。\n\(error.localizedDescription)" }
    }
}

struct DeckWebView: UIViewRepresentable {
    let url: URL
    @ObservedObject var model: AppModel
    func makeCoordinator() -> Coordinator { Coordinator(origin: url, model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let userContent = configuration.userContentController
        if let path = Bundle.main.url(forResource: "NativeMIDIBridge", withExtension: "js"),
           let script = try? String(contentsOf: path, encoding: .utf8) {
            userContent.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if let path = Bundle.main.url(forResource: "NativeUSBBridge", withExtension: "js"),
           let script = try? String(contentsOf: path, encoding: .utf8) {
            userContent.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        userContent.addScriptMessageHandler(context.coordinator.usb, contentWorld: .page, name: "deckflowUSB")
        userContent.add(context.coordinator, name: "deckflowMIDI")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        context.coordinator.webView = webView
        context.coordinator.usb.webView = webView
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "deckflowMIDI")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "deckflowUSB", contentWorld: .page)
        coordinator.midi.stop()
        webView.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        let origin: URL
        weak var model: AppModel?
        weak var webView: WKWebView?
        let midi = NativeMIDI()
        let usb: NativeUSB
        private var downloads: [ObjectIdentifier: URL] = [:]

        init(origin: URL, model: AppModel) {
            self.origin = origin; self.model = model
            self.usb = NativeUSB(origin: origin)
            super.init()
            midi.onPorts = { [weak self] inputs in self?.send(["kind": "ports", "inputs": inputs]) }
            midi.onMessages = { [weak self] id, messages in self?.send(["kind": "messages", "inputId": id, "messages": messages]) }
        }

        private func sameOrigin(_ url: URL) -> Bool {
            url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let security = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, security.protocol == origin.scheme, security.host == origin.host, security.port == origin.port,
                  let current = webView?.url, sameOrigin(current),
                  let body = message.body as? [String: Any], body["command"] as? String == "enable",
                  let requestId = body["requestId"] as? Int, requestId > 0 else { return }
            do { send(["kind": "access", "requestId": requestId, "inputs": try midi.enable()]) }
            catch { send(["kind": "error", "requestId": requestId, "message": error.localizedDescription]) }
        }

        private func send(_ payload: [String: Any]) {
            guard let webView, let url = webView.url, sameOrigin(url) else { return }
            // Passing structured arguments avoids interpolating device names,
            // MIDI data, or errors into executable JavaScript source.
            webView.callAsyncJavaScript("window.__deckflowNativeMIDI?.receive(payload);", arguments: ["payload": payload], in: nil, in: .page) { _ in }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if navigationAction.shouldPerformDownload,
               sameOrigin(url) || url.absoluteString.hasPrefix("blob:\(origin.scheme!)://\(origin.host!):\(origin.port!)/") {
                decisionHandler(.download); return
            }
            decisionHandler(sameOrigin(url) ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // The bundled workspace does not open arbitrary remote windows.
            nil
        }

        private func localFrame(_ frame: WKFrameInfo) -> Bool {
            let security = frame.securityOrigin
            return frame.isMainFrame && security.protocol == origin.scheme && security.host == origin.host && security.port == origin.port
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard localFrame(frame), let controller = presentingController(), !(controller is UIAlertController) else { completionHandler(); return }
            let alert = UIAlertController(title: "DECKFLOW", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "閉じる", style: .default) { _ in completionHandler() })
            controller.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard localFrame(frame), let controller = presentingController(), !(controller is UIAlertController) else { completionHandler(false); return }
            let alert = UIAlertController(title: "DECKFLOW", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "続ける", style: .default) { _ in completionHandler(true) })
            controller.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            guard localFrame(frame), let controller = presentingController(), !(controller is UIAlertController) else { completionHandler(nil); return }
            let alert = UIAlertController(title: "DECKFLOW", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText; $0.clearButtonMode = .whileEditing }
            alert.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "保存", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
            controller.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            showMessage("画面を読み込めませんでした。\n\(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            do {
                let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Exports", isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                let name = (suggestedFilename as NSString).lastPathComponent
                let safe = name.isEmpty || name == "." || name == ".." ? "deckflow-export.json" : name.replacingOccurrences(of: ":", with: "-")
                var target = root.appendingPathComponent(safe)
                if FileManager.default.fileExists(atPath: target.path) { target = root.appendingPathComponent("\(UUID().uuidString.prefix(8))-\(safe)") }
                downloads[ObjectIdentifier(download)] = target
                completionHandler(target)
            } catch { showMessage(error.localizedDescription); completionHandler(nil) }
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)), let controller = presentingController() else { return }
            let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            share.popoverPresentationController?.sourceView = webView
            share.popoverPresentationController?.sourceRect = CGRect(x: (webView?.bounds.midX ?? 0), y: (webView?.bounds.midY ?? 0), width: 1, height: 1)
            controller.present(share, animated: true)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
            showMessage("書き出しに失敗しました。\n\(error.localizedDescription)")
        }

        private func presentingController() -> UIViewController? {
            var controller = webView?.window?.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller
        }

        private func showMessage(_ message: String) {
            let alert = UIAlertController(title: "DECKFLOW", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "閉じる", style: .default))
            presentingController()?.present(alert, animated: true)
        }
    }
}

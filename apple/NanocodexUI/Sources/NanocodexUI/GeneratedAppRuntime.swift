import Foundation
import CoreFoundation
import WebKit

/// Runs untrusted generated HTML. The host must bind this callback to fixed app/account
/// identities and apply normal agent permissions; neither identity nor credentials belong
/// in the document or the callback's JSON results.
@MainActor
public final class GeneratedAppRuntime: NSObject {
    public typealias Host = @MainActor (String, Data) async throws -> Data
    public let webView: WKWebView

    /// Only explicitly safe host errors may cross into generated JavaScript.
    public struct HostError: Error, Sendable {
        public let code: String
        public let message: String
        public init(code: String, message: String) { self.code = code; self.message = message }
    }

    private let host: Host
    private let onError: @MainActor (String) -> Void
    private let bridge: Bridge
    private var documentID = UUID().uuidString
    private var valid = true
    private var allowsInitialNavigation = false
    private var errorCount = 0
    private var gestureDeadline: TimeInterval = 0
    private static let gestureWorld = WKContentWorld.world(name: "NanocodexGeneratedAppGestures")
    private var inFlight = 0
    private var pending: [UUID: Pending] = [:]
    private static let messageLimit = 2 * 1024 * 1024
    private static let resultLimit = 2 * 1024 * 1024
    private static let contentLimit = 256 * 1024
    private static let policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'; font-src 'none'; worker-src 'none'"

    private struct Pending {
        let task: Task<Void, Never>
        let reply: (Any?, String?) -> Void
    }

    public init(request: @escaping Host, failure: @escaping @MainActor (String) -> Void = { _ in }) async throws {
        self.host = request
        self.onError = failure
        bridge = Bridge()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // Compilation is mandatory: failure leaves no runnable generated document.
        let rules = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "NanocodexGeneratedAppDenyNetwork-v1",
            encodedContentRuleList: #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]"#
        )
        guard let rules else { throw RuntimeError.contentRulesUnavailable }
        configuration.userContentController.add(rules)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "nanocodexBridge")
        configuration.userContentController.add(bridge, name: "nanocodexRuntimeError")
        configuration.userContentController.add(bridge, contentWorld: Self.gestureWorld, name: "nanocodexGesture")
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        bridge.owner = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
    }

    /// Replaces the document, rejecting outstanding replies from its predecessor.
    public func load(html: String) {
        guard valid else { return }
        cancelReplies()
        documentID = UUID().uuidString
        errorCount = 0
        gestureDeadline = 0
        webView.stopLoading()
        guard html.utf8.count <= Self.contentLimit else {
            invalidate()
            onError("Generated app HTML exceeds the 256 KiB limit.")
            return
        }
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: """
        (() => {
          const notify = window.webkit.messageHandlers.nanocodexGesture.postMessage.bind(window.webkit.messageHandlers.nanocodexGesture);
          const grant = event => {
            if (event.isTrusted && !event.repeat && (event.type === 'click' || event.key === 'Enter' || event.key === ' ')) notify('\(documentID)');
          };
          window.addEventListener('click', grant, true);
          window.addEventListener('keydown', grant, true);
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.gestureWorld))
        controller.addUserScript(WKUserScript(source: Self.bootstrap(documentID), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        allowsInitialNavigation = true
        // The policy is parsed before ANY generated markup, including a generated <head>.
        webView.loadHTMLString("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"\(Self.policy)\">" + html, baseURL: nil)
    }

    /// Permanently revokes this instance, including already queued bridge messages.
    public func invalidate() {
        guard valid else { return }
        valid = false
        gestureDeadline = 0
        allowsInitialNavigation = false
        documentID = UUID().uuidString
        cancelReplies()
        webView.stopLoading()
        let controller = webView.configuration.userContentController
        controller.removeAllScriptMessageHandlers()
        controller.removeAllUserScripts()
        // Keep navigation delegates installed so retained views cannot navigate after teardown.
    }

    private func cancelReplies() {
        let abandoned = pending
        pending.removeAll()
        for request in abandoned.values {
            request.task.cancel()
            request.reply(nil, "This app document is no longer active.")
        }
        // inFlight counts host work until it actually returns, even if it ignores cancellation.
    }

    private func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard valid, message.webView === webView, message.frameInfo.isMainFrame,
              let envelope = message.body as? [String: Any],
              Set(envelope.keys) == ["document", "method", "input"],
              envelope["document"] as? String == documentID,
              let method = envelope["method"] as? String,
              let input = envelope["input"] as? [String: Any] else {
            reply(nil, "Inactive or invalid app message.")
            return
        }
        do {
            let bytes = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys, .withoutEscapingSlashes])
            guard bytes.count <= Self.messageLimit else { throw RuntimeError.invalidInput }
            switch method {
            case "data.get":
                guard input.isEmpty else { throw RuntimeError.invalidInput }
            case "data.set":
                guard Set(input.keys) == ["value", "revision"],
                      let revision = input["revision"] as? NSNumber,
                      CFGetTypeID(revision) != CFBooleanGetTypeID(),
                      revision.doubleValue >= 0, revision.doubleValue <= 9_007_199_254_740_991,
                      revision.doubleValue.rounded(.down) == revision.doubleValue else { throw RuntimeError.invalidInput }
                let valueBytes = try JSONSerialization.data(withJSONObject: input["value"]!, options: [.fragmentsAllowed, .withoutEscapingSlashes])
                guard valueBytes.count <= Self.contentLimit else { throw RuntimeError.invalidInput }
            case "agent.request":
                guard Set(input.keys) == ["prompt"], let prompt = input["prompt"] as? String,
                      !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      prompt.utf8.count <= 16 * 1024 else { throw RuntimeError.invalidInput }
                guard ProcessInfo.processInfo.systemUptime <= gestureDeadline else { throw RuntimeError.gestureRequired }
                gestureDeadline = 0
            default:
                throw RuntimeError.unsupportedMethod
            }
            guard inFlight < 8 else { throw RuntimeError.busy }
            inFlight += 1
            let requestID = UUID()
            let generation = documentID
            let callback = host
            let task = Task { [weak self] in
                let result: Result<Data, Error>
                do {
                    try Task.checkCancellation()
                    result = .success(try await callback(method, bytes))
                } catch { result = .failure(error) }
                self?.finish(requestID, document: generation, result: result)
            }
            pending[requestID] = Pending(task: task, reply: reply)
        } catch {
            let description = (error as? RuntimeError)?.description ?? "Invalid app message."
            reply(nil, description)
            report(description)
        }
    }

    private func finish(_ id: UUID, document: String, result: Result<Data, Error>) {
        inFlight -= 1
        guard let request = pending.removeValue(forKey: id) else { return }
        guard valid, document == documentID else {
            request.reply(nil, "This app document is no longer active.")
            return
        }
        do {
            let bytes = try result.get()
            guard bytes.count <= Self.resultLimit else { throw RuntimeError.invalidResult }
            _ = try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])
            guard let json = String(data: bytes, encoding: .utf8) else { throw RuntimeError.invalidResult }
            request.reply(json, nil)
        } catch let error as HostError {
            let safeError = ["code": String(error.code.prefix(64)), "message": String(error.message.prefix(512))]
            if let encoded = try? JSONSerialization.data(withJSONObject: safeError), let json = String(data: encoded, encoding: .utf8) {
                request.reply(nil, "NANOCODEX_ERROR:" + json)
            } else { request.reply(nil, "The app request failed.") }
            report(safeError["message"] ?? "The app request failed.")
        } catch {
            // Host errors may contain transport details. Never send them to generated code.
            request.reply(nil, "The app request failed.")
            report("The app request failed.")
        }
    }

    private func report(_ description: String) {
        guard errorCount < 20 else { return }
        errorCount += 1
        onError(String(description.prefix(2048)))
    }

    private static func bootstrap(_ document: String) -> String {
        """
        (() => {
          'use strict';
          // WebRTC ICE can issue UDP requests outside CSP/content-rule resource loading.
          for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport']) {
            Object.defineProperty(window, name, {value: undefined, writable: false, configurable: false});
          }
          const send = window.webkit.messageHandlers.nanocodexBridge.postMessage.bind(window.webkit.messageHandlers.nanocodexBridge);
          const parse = JSON.parse.bind(JSON), stringify = JSON.stringify.bind(JSON);
          const invoke = async (method, input) => {
            const message = {document: '\(document)', method, input};
            if (stringify(message).length > \(messageLimit)) throw new Error('App message is too large.');
            try { return parse(await send(message)); }
            catch (failure) {
              const text = String(failure.message || failure), marker = 'NANOCODEX_ERROR:';
              const position = text.indexOf(marker);
              if (position >= 0) {
                let details;
                try { details = parse(text.slice(position + marker.length)); } catch (_) {}
                if (details) { const error = new Error(details.message); error.code = details.code; throw error; }
              }
              throw failure;
            }
          };
          const api = Object.freeze({
            data: Object.freeze({get: () => invoke('data.get', {}), set: (value, revision) => invoke('data.set', {value, revision})}),
            agent: Object.freeze({request: prompt => invoke('agent.request', {prompt})})
          });
          Object.defineProperty(window, 'nanocodex', {value: api, configurable: false, writable: false});
          const report = message => window.webkit.messageHandlers.nanocodexRuntimeError.postMessage({document: '\(document)', message: String(message).slice(0, 2048)});
          window.addEventListener('error', event => report(event.message || 'Generated app script failed.'));
          window.addEventListener('unhandledrejection', () => report('Generated app request was rejected.'));
        })();
        """
    }

    private enum RuntimeError: Error {
        case contentRulesUnavailable, invalidInput, unsupportedMethod, busy, invalidResult, gestureRequired
        var description: String {
            switch self {
            case .contentRulesUnavailable: return "App network restrictions could not be installed."
            case .invalidInput: return "Invalid app request input."
            case .unsupportedMethod: return "Unsupported app method."
            case .busy: return "Too many app requests are in progress."
            case .invalidResult: return "Invalid app response."
            case .gestureRequired: return "Tap an app action to request your agent."
            }
        }
    }

    @MainActor
    private final class Bridge: NSObject, WKScriptMessageHandlerWithReply, WKScriptMessageHandler {
        weak var owner: GeneratedAppRuntime?
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard let owner else { replyHandler(nil, "App is closed."); return }
            owner.receive(message, reply: replyHandler)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let owner, owner.valid, message.webView === owner.webView, message.frameInfo.isMainFrame else { return }
            if message.name == "nanocodexGesture" {
                guard message.body as? String == owner.documentID else { return }
                owner.gestureDeadline = ProcessInfo.processInfo.systemUptime + 1
                return
            }
            guard let body = message.body as? [String: Any], body["document"] as? String == owner.documentID,
                  let description = body["message"] as? String else { return }
            owner.report(description)
        }
    }
}

extension GeneratedAppRuntime: WKNavigationDelegate, WKUIDelegate {
    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if valid, allowsInitialNavigation, navigationAction.targetFrame?.isMainFrame == true,
           navigationAction.navigationType == .other, navigationAction.request.url?.absoluteString == "about:blank" {
            allowsInitialNavigation = false
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if valid { report("Navigation is unavailable in generated apps.") }
        }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    public func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                        decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if valid, (error as NSError).code != NSURLErrorCancelled { report("The generated app could not load.") }
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if valid { report("The generated app could not load.") }
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        invalidate()
        report("The generated app stopped. Reopen it to continue.")
    }
}

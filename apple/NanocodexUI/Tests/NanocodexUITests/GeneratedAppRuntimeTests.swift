#if os(macOS)
import AppKit
import Network
import WebKit
import XCTest
@testable import NanocodexUI

/// Real generated HTML and WebKit message transport, with an in-memory persistence host.
@MainActor
final class GeneratedAppRuntimeTests: XCTestCase {
    func testButtonsPersistReopenAndRequestAgentOnlyAfterTrustedGesture() async throws {
        var value: Any = NSNull()
        var revision = 0
        var calls: [String] = []
        var errors: [String] = []
        let host: GeneratedAppRuntime.Host = { method, bytes in
            calls.append(method)
            let input = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            switch method {
            case "data.get": break
            case "data.set":
                guard input["revision"] as? Int == revision else {
                    throw GeneratedAppRuntime.HostError(code: "revision_conflict", message: "Reload the saved data.")
                }
                value = try XCTUnwrap(input["value"])
                revision += 1
            case "agent.request":
                XCTAssertEqual(input["prompt"] as? String, "Explain my saved counter")
                return Data(#"{"answer":"Counter reviewed by host"}"#.utf8)
            default: XCTFail("Unapproved method reached host: \(method)")
            }
            return try JSONSerialization.data(withJSONObject: ["value": value, "revision": revision])
        }
        let html = #"""
        <h1>My arbitrary counter</h1><output id="count">loading</output>
        <button id="add">Add one</button><button id="ask">Ask my agent</button>
        <button id="bad">Unsupported</button><button id="invalid">Invalid</button><button id="conflict">Conflict</button>
        <output id="answer"></output><output id="rejection"></output>
        <button id="large">Save large data</button><output id="largeResult"></output>
        <script>
        let state;
        async function read() { state = await nanocodex.data.get(); count.textContent = String(state.value || 0); }
        add.onclick = async () => { state = await nanocodex.data.set((state.value || 0) + 1, state.revision); count.textContent = state.value; };
        ask.onclick = async () => {
          try { answer.textContent = (await nanocodex.agent.request('Explain my saved counter')).answer; }
          catch(e) { answer.textContent = 'gesture rejected'; }
        };
        bad.onclick = async () => {
          // A token is document freshness, never an app/account identity or secret.
          // Intercept page-world diagnostics to exercise a correctly shaped forbidden method.
          const reporter = webkit.messageHandlers.nanocodexRuntimeError, saved = reporter.postMessage;
          let token;
          reporter.postMessage = m => { token = m.document; };
          window.dispatchEvent(new ErrorEvent('error', {message:'probe'}));
          reporter.postMessage = saved;
          try { await webkit.messageHandlers.nanocodexBridge.postMessage({document:token, method:'account.delete', input:{account_id:'forged'}}); }
          catch(e) { rejection.textContent = String(e); }
        };
        invalid.onclick = async () => {
          try { await nanocodex.data.set('bad', true); } catch(e) { rejection.textContent = 'invalid rejected'; }
        };
        conflict.onclick = async () => {
          try { await nanocodex.data.set('stale', 0); } catch(e) { rejection.textContent = e.code; }
        };
        large.onclick = async () => {
          state = await nanocodex.data.set('/'.repeat(240 * 1024), state.revision);
          largeResult.textContent = String((await nanocodex.data.get()).value.length);
        };
        read();
        </script>
        """#
        let runtime = try await GeneratedAppRuntime(request: host, failure: { errors.append($0) })
        let window = show(runtime.webView)
        defer { runtime.invalidate(); window.close() }
        runtime.load(html: html)
        try await wait(runtime, "document.getElementById('count')?.textContent === '0'")
        try await click(runtime, "add")
        try await wait(runtime, "count.textContent === '1'")
        try await click(runtime, "ask")
        try await wait(runtime, "answer.textContent === 'gesture rejected'")
        XCTAssertFalse(calls.contains("agent.request"), "Page-generated clicks cannot authorize agent requests")
        try await trustedClick(runtime, "ask")
        try await wait(runtime, "answer.textContent === 'Counter reviewed by host'")
        try await click(runtime, "ask")
        try await wait(runtime, "answer.textContent === 'gesture rejected'")
        XCTAssertEqual(calls.filter { $0 == "agent.request" }.count, 1, "A gesture is consumed once")
        let countBeforeRejections = calls.count
        try await click(runtime, "bad")
        try await wait(runtime, "rejection.textContent.includes('Unsupported app method.')")
        try await click(runtime, "invalid")
        try await wait(runtime, "rejection.textContent === 'invalid rejected'")
        XCTAssertEqual(calls.count, countBeforeRejections)
        XCTAssertTrue(errors.contains("Invalid app request input."))
        try await click(runtime, "conflict")
        try await wait(runtime, "rejection.textContent === 'revision_conflict'")
        let countBeforeClose = calls.count
        runtime.invalidate()
        try await click(runtime, "add")
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(calls.count, countBeforeClose)
        let reopened = try await GeneratedAppRuntime(request: host)
        let reopenedWindow = show(reopened.webView)
        defer { reopened.invalidate(); reopenedWindow.close() }
        reopened.load(html: html)
        try await wait(reopened, "document.getElementById('count')?.textContent === '1'")
        XCTAssertEqual(revision, 1)
        XCTAssertEqual(calls, ["data.get", "data.set", "agent.request", "data.set", "data.get"])
        try await click(reopened, "large")
        try await wait(reopened, "largeResult.textContent === '245760'")
        XCTAssertEqual((value as? String)?.utf8.count, 245760)
        evidence("240 KiB state also roundtripped. Counter get=0, set(value=1,revision=0)=>revision=1, reopen=1. Native mouse click authorized exactly one agent request; synthetic clicks rejected. Unsupported/invalid rejected, stale revision exposed error.code=revision_conflict; invalidation stopped host calls.")
    }

    func testNetworkNavigationAndSubframeEscapesDenied() async throws {
        let server = try await LoopbackServer.start()
        defer { server.stop() }
        _ = try await URLSession.shared.data(from: server.url)
        let baseline = server.count
        XCTAssertEqual(baseline, 1, "The control endpoint must actually be reachable")
        var calls: [String] = []
        var errors: [String] = []
        let runtime = try await GeneratedAppRuntime(request: { method, _ in
            calls.append(method)
            return Data(#"{"value":null,"revision":0}"#.utf8)
        }, failure: { errors.append($0) })
        let window = show(runtime.webView)
        defer { runtime.invalidate(); window.close() }
        runtime.load(html: """
        <h1 id="marker" style="color:rgb(1,2,3)">Still inside my app</h1>
        <img id="localImage" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
        <script src="\(server.url)script"></script>
        <link rel="stylesheet" href="\(server.url)style">
        <style>@import url('\(server.url)import');body{background-image:url('\(server.url)background')}</style>
        <img src="\(server.url)image"><iframe src="\(server.url)frame"></iframe>
        <iframe srcdoc="<script>parent.nanocodex.data.get()</script>"></iframe>
        <iframe src="file:///etc/hosts"></iframe>
        <button id="escape">Attempt escapes</button><output id="result"></output>
        <a id="navigate" href="\(server.url)navigation">Leave app</a>
        <a id="file" href="file:///etc/hosts">Read file</a><a id="blank" href="about:blank">Blank</a>
        <form action="\(server.url)form"><button id="submit">Submit</button></form>
        <script>
        document.getElementById('escape').onclick = async () => {
          let denied = 0;
          try { await fetch('\(server.url)fetch'); } catch(e) { denied++; }
          try { const x = new XMLHttpRequest(); x.open('GET','\(server.url)xhr'); x.send(); } catch(e) {}
          try { navigator.sendBeacon('\(server.url)beacon','private'); } catch(e) {}
          try { new WebSocket('\(server.url.absoluteString.replacingOccurrences(of: "http:", with: "ws:"))socket'); } catch(e) {}
          window.open('\(server.url)popup');
          result.textContent = String(denied);
        };
        </script>
        """)
        try await wait(runtime, "document.getElementById('escape') !== null")
        try await wait(runtime, "document.getElementById('localImage').naturalWidth === 1")
        let inlineStyle = try await runtime.webView.evaluateJavaScript("getComputedStyle(document.getElementById('marker')).color") as? String
        XCTAssertEqual(inlineStyle, "rgb(1, 2, 3)")
        let privateGestureHandler = try await runtime.webView.evaluateJavaScript("typeof webkit.messageHandlers.nanocodexGesture") as? String
        XCTAssertEqual(privateGestureHandler, "undefined")
        let rtc = try await runtime.webView.evaluateJavaScript("typeof RTCPeerConnection") as? String
        XCTAssertEqual(rtc, "undefined")
        try await click(runtime, "escape")
        try await wait(runtime, "result.textContent === '1'")
        for id in ["navigate", "file", "blank", "submit"] { try await click(runtime, id) }
        try await Task.sleep(for: .milliseconds(500))
        let marker = try await runtime.webView.evaluateJavaScript("document.getElementById('marker')?.textContent") as? String
        XCTAssertEqual(marker, "Still inside my app")
        XCTAssertEqual(runtime.webView.url?.absoluteString, "about:blank")
        XCTAssertEqual(server.count, baseline, "No generated-content request may escape")
        XCTAssertTrue(calls.isEmpty, "srcdoc must not execute and acquire the parent's bridge")
        XCTAssertTrue(errors.contains("Navigation is unavailable in generated apps."))
        evidence("Inline styles/data image rendered; isolated gesture handler and WebRTC unavailable to page. Reachable HTTP server: one native control request, zero generated-content requests. Fetch/XHR/beacon/WebSocket/scripts/styles/images/frames/forms/popups denied. HTTP/file/about:blank navigation retained app. srcdoc made zero host calls.")
    }

    func testConcurrencyReplacementAndInvalidation() async throws {
        var continuations: [CheckedContinuation<Data, Never>] = []
        var calls = 0
        let runtime = try await GeneratedAppRuntime(request: { _, _ in
            calls += 1
            return await withCheckedContinuation { continuations.append($0) }
        })
        let window = show(runtime.webView)
        defer { runtime.invalidate(); window.close() }
        runtime.load(html: #"""
        <button id="start">Start nine requests</button><output id="result"></output>
        <script>
        start.onclick = () => {
          for(let i=0;i<9;i++) nanocodex.data.get().then(() => result.textContent += 'resolved;').catch(() => result.textContent += 'rejected;');
        };
        </script>
        """#)
        try await wait(runtime, "document.getElementById('start') !== null")
        try await click(runtime, "start")
        try await wait(runtime, "result.textContent === 'rejected;'")
        XCTAssertEqual(calls, 8)
        runtime.load(html: "<output id='result'>replacement</output><button id='ask' onclick='nanocodex.data.get().catch(()=>{})'>Ask</button>")
        try await wait(runtime, "document.getElementById('result')?.textContent === 'replacement'")
        try await click(runtime, "ask")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(calls, 8, "Cancelled host operations consume slots until they finish")
        for continuation in continuations { continuation.resume(returning: Data(#"{"value":"old reply","revision":0}"#.utf8)) }
        continuations.removeAll()
        try await Task.sleep(for: .milliseconds(150))
        let replacement = try await runtime.webView.evaluateJavaScript("result.textContent") as? String
        XCTAssertEqual(replacement, "replacement", "Old replies cannot land in the replacement document")
        runtime.invalidate()
        try await click(runtime, "ask")
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(calls, 8)
        evidence("Nine concurrent requests: eight admitted, one rejected. Replacement retained the limit while cancelled host operations finished; no old reply reached replacement. Invalidation denied new host calls.")
    }

    private func show(_ webView: WKWebView) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 600, height: 500), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.orderBack(nil)
        return window
    }
    private func click(_ runtime: GeneratedAppRuntime, _ id: String) async throws {
        _ = try await runtime.webView.evaluateJavaScript("document.getElementById('\(id)').click(); null")
    }
    private func trustedClick(_ runtime: GeneratedAppRuntime, _ id: String) async throws {
        let coordinates = try await runtime.webView.evaluateJavaScript("(() => {const r=document.getElementById('\(id)').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        let point = try XCTUnwrap(coordinates as? [Double])
        let view = runtime.webView
        let window = try XCTUnwrap(view.window)
        let y = view.isFlipped ? point[1] : view.bounds.height - point[1]
        let location = view.convert(NSPoint(x: point[0], y: y), to: nil)
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            window.sendEvent(event)
        }
    }
    private func wait(_ runtime: GeneratedAppRuntime, _ expression: String) async throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if (try? await runtime.webView.evaluateJavaScript(expression)) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTFail("WebKit journey timed out: \(expression)")
        throw NSError(domain: "GeneratedAppRuntimeTests", code: 1)
    }
    private func evidence(_ message: String) {
        let attachment = XCTAttachment(string: message)
        attachment.name = "Generated app runtime journey"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("GENERATED_APP_JOURNEY: \(message)")
    }
}

private final class LoopbackServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "GeneratedAppRuntimeTests.loopback")
    private let lock = NSLock()
    private var requests = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return requests }
    var url: URL { URL(string: "http://127.0.0.1:\(listener.port!.rawValue)/")! }
    private init() throws { listener = try NWListener(using: .tcp, on: .any) }
    static func start() async throws -> LoopbackServer {
        let server = try LoopbackServer()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            server.listener.stateUpdateHandler = { state in
                switch state {
                case .ready: server.listener.stateUpdateHandler = nil; continuation.resume()
                case .failed(let error): server.listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
                default: break
                }
            }
            server.listener.newConnectionHandler = { [weak server] connection in
                guard let server else { connection.cancel(); return }
                connection.start(queue: server.queue)
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                    server.lock.lock(); server.requests += 1; server.lock.unlock()
                    connection.send(content: Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".utf8), completion: .contentProcessed { _ in connection.cancel() })
                }
            }
            server.listener.start(queue: server.queue)
        }
        return server
    }
    func stop() { listener.cancel() }
}
#endif

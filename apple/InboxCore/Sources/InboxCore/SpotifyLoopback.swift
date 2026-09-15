import Foundation
import Network

/// Only the authorization code crosses this boundary. The broker owns PKCE
/// and the renewable tokens. Never log a callback URL or its query.
public struct SpotifyLoopbackCallback: Sendable, Equatable {
    public let state: String
    public let code: String?
    public let error: String?

    public var body: JSON {
        .object(["state": .string(state), code == nil ? "error" : "code": .string(code ?? error ?? "access_denied")])
    }

    public static func parse(_ request: String, expectedState: String) -> Self? {
        guard request.utf8.count <= 16_384, request.hasSuffix("\r\n\r\n") else { return nil }
        let lines = request.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[0] == "GET", first[2] == "HTTP/1.1",
              first[1].hasPrefix("/login?"),
              let url = URLComponents(string: "http://127.0.0.1:8989" + first[1]),
              url.path == "/login", url.fragment == nil else { return nil }
        let headers = lines.dropFirst().filter { !$0.isEmpty }.map { $0.split(separator: ":", maxSplits: 1) }
        guard headers.allSatisfy({ $0.count == 2 }),
              headers.filter({ $0[0].lowercased() == "host" }).count == 1,
              headers.first(where: { $0[0].lowercased() == "host" })?[1].trimmingCharacters(in: .whitespaces) == "127.0.0.1:8989",
              !headers.contains(where: { ["transfer-encoding", "content-length"].contains($0[0].lowercased()) }) else { return nil }
        let items = url.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count,
              items.allSatisfy({ ["code", "state", "error", "error_description"].contains($0.name) }),
              items.first(where: { $0.name == "state" })?.value == expectedState else { return nil }
        let code = items.first(where: { $0.name == "code" })?.value
        let error = items.first(where: { $0.name == "error" })?.value
        guard (code == nil) != (error == nil), let value = code ?? error,
              !value.isEmpty, value.utf8.count <= 4096,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return Self(state: expectedState, code: code, error: error)
    }
}

/// Lives in the foreground app while SFSafariViewController presents consent.
/// Bind before opening Spotify so an occupied port fails without starting OAuth.
@MainActor
public final class SpotifyLoopbackReceiver {
    public var onCallback: ((SpotifyLoopbackCallback) -> Void)?
    public var onFailure: (() -> Void)?
    private var listener: NWListener?
    private var ready: CheckedContinuation<Void, Error>?
    private var expectedState: String?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var timeout: Task<Void, Never>?

    public init() {}

    public func start() async throws {
        stop()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 8989)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        listener.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch state {
                case .ready: self.ready?.resume(); self.ready = nil
                case .failed:
                    let wasStarting = self.ready != nil
                    self.stop()
                    if !wasStarting { self.onFailure?() }
                default: break
                }
            }
        }
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(600)) } catch { return }
            self?.stop(); self?.onFailure?()
        }
        try await withCheckedThrowingContinuation { continuation in
            ready = continuation
            listener.start(queue: .main)
        }
    }

    public func expect(state: String) { expectedState = state }

    public func stop() {
        expectedState = nil
        listener?.stateUpdateHandler = nil; listener?.newConnectionHandler = nil
        listener?.cancel(); listener = nil
        ready?.resume(throwing: CancellationError()); ready = nil
        timeout?.cancel(); timeout = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 8 else { connection.cancel(); return }
        let id = ObjectIdentifier(connection)
        connections[id] = connection
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak connection] in
            guard let self, let connection, self.connections[id] === connection else { return }
            connection.cancel(); self.connections[id] = nil
        }
        receive(connection, data: Data())
    }

    private func receive(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_385 - data.count) { [weak self] chunk, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, self.connections[ObjectIdentifier(connection)] != nil else { return }
                var buffer = data
                if let chunk { buffer.append(chunk) }
                guard error == nil, buffer.count <= 16_384 else { self.finish(connection, callback: nil); return }
                if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
                    let callback = self.expectedState.flatMap { state in
                        String(data: buffer, encoding: .utf8).flatMap { SpotifyLoopbackCallback.parse($0, expectedState: state) }
                    }
                    self.finish(connection, callback: callback)
                } else if complete { self.finish(connection, callback: nil) }
                else { self.receive(connection, data: buffer) }
            }
        }
    }

    private func finish(_ connection: NWConnection, callback: SpotifyLoopbackCallback?) {
        if callback != nil { expectedState = nil } // Consume before any asynchronous send.
        let message = callback == nil ? "Invalid callback." : "Returning to Nanocodex. You can close this page."
        let response = "HTTP/1.1 \(callback == nil ? "400 Bad Request" : "200 OK")\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(message.utf8.count)\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n\(message)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated {
                connection.cancel()
                self?.connections[ObjectIdentifier(connection)] = nil
                // Also deliver when Safari closes early: the code was received.
                if let callback { self?.onCallback?(callback) }
            }
        })
        if callback != nil {
            listener?.cancel(); listener = nil
            timeout?.cancel(); timeout = nil
        }
    }
}

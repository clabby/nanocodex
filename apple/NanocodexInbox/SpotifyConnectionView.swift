import SwiftUI
import SafariServices
import InboxCore

struct MusicConnectionView: View {
    @ObservedObject var model: InboxModel
    @StateObject private var connection: MusicConnectionModel
    private let provider: MusicLoopbackProvider

    init(model: InboxModel, provider: MusicLoopbackProvider = .spotify) {
        self.model = model
        self.provider = provider
        _connection = StateObject(wrappedValue: MusicConnectionModel(provider: provider))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(connection.connections) { account in
                HStack {
                    Label(account.label, systemImage: "checkmark.circle")
                    Spacer()
                    Button("Disconnect", role: .destructive) { connection.disconnect(account) }
                        .disabled(connection.busy)
                }
            }
            Button(connection.labels.isEmpty ? "Connect \(provider.name)" : "Connect another \(provider.name) account") {
                connection.connect()
            }
            .disabled(connection.busy)
            .accessibilityIdentifier("connect-\(provider.rawValue)")
            if connection.busy { ProgressView("Connecting \(provider.name)…") }
            if let error = connection.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            Text(provider == .spotify
                ? "Let your agents read and manage your playlists and library. Spotify shows ncspot on the consent screen."
                : "Let your agents read and manage your SoundCloud playlists, likes, and follows.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .task { await connection.load(client: model.musicConnectorClient()) }
        .onDisappear { connection.close() }
        .sheet(item: $connection.browser, onDismiss: { connection.cancelAuthorization() }) { browser in
            SpotifyAuthorizationBrowser(url: browser.url, cancel: { connection.cancelAuthorization() })
                .ignoresSafeArea()
                .interactiveDismissDisabled()
        }
    }
}

@MainActor
private final class MusicConnectionModel: ObservableObject {
    struct Browser: Identifiable { let id = UUID(); let url: URL }
    @Published var browser: Browser?
    struct Connection: Identifiable { let id: String; let label: String }
    @Published var connections: [Connection] = []
    var labels: [String] { connections.map(\.label) }
    @Published var busy = false
    @Published var error: String?
    private let provider: MusicLoopbackProvider
    init(provider: MusicLoopbackProvider) { self.provider = provider }
    private var client: ManagedClient?
    private var receiver: SpotifyLoopbackReceiver?
    private var task: Task<Void, Never>?
    private var attempt = UUID()

    func load(client: ManagedClient?) async {
        self.client?.close(); self.client = client
        guard let client else { return }
        do {
            let result = try await client.json(path: "/v1/connectors/\(provider.rawValue)/loopback")
            connections = result[provider.rawValue]["connections"].array.map { Connection(id: $0["id"].string, label: $0["label"].string) }
        } catch { self.error = "Could not load \(provider.name) connections. Try connecting again." }
    }

    func connect() {
        guard !busy, let client else { return }
        busy = true; error = nil
        let id = UUID(); attempt = id
        let receiver = SpotifyLoopbackReceiver(provider: provider); self.receiver = receiver
        receiver.onFailure = { [weak self] in
            guard let self, self.attempt == id else { return }
            self.cancelAuthorization(); self.error = "\(self.provider.name) sign-in timed out or the local callback became unavailable. Try again."
        }
        receiver.onCallback = { [weak self] callback in self?.complete(callback, attempt: id) }
        task = Task {
            do {
                try await receiver.start()
                let result = try await client.json(path: "/v1/connectors/\(provider.rawValue)/loopback", method: "POST", body: .object([:]))
                guard attempt == id, !Task.isCancelled else { return }
                guard let url = URL(string: result["authorization_url"].string),
                      url.scheme == "https", url.host == provider.authorizationHost, url.port == nil,
                      url.path == "/authorize", url.user == nil, url.password == nil, url.fragment == nil,
                      let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                      let items = parts.queryItems,
                      Set(items.map(\.name)).count == items.count,
                      let clientID = items.first(where: { $0.name == "client_id" })?.value, !clientID.isEmpty,
                      (provider != .spotify || clientID == "d420a117a32841c2b3474932e49fb54b"),
                      items.first(where: { $0.name == "redirect_uri" })?.value == provider.redirectURI,
                      items.first(where: { $0.name == "code_challenge_method" })?.value == "S256",
                      let state = items.first(where: { $0.name == "state" })?.value,
                      state.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw APIError.invalidResponse }
                receiver.expect(state: state)
                browser = Browser(url: url)
            } catch {
                guard attempt == id else { return }
                cancelAuthorization()
                self.error = "Could not start \(provider.name) sign-in. Close any other \(provider.name) connection attempt and try again."
            }
        }
    }

    private func complete(_ callback: SpotifyLoopbackCallback, attempt id: UUID) {
        guard attempt == id, let client else { return }
        receiver?.stop(); receiver = nil
        browser = nil
        task = Task {
            do {
                let result = try await client.json(path: "/v1/connectors/\(provider.rawValue)/loopback/callback", method: "POST", body: callback.body)
                guard attempt == id else { return }
                guard result["connected"].bool else {
                    busy = false; error = "\(provider.name) connection was cancelled."; return
                }
                let status = try await client.json(path: "/v1/connectors/\(provider.rawValue)/loopback")
                guard attempt == id else { return }
                connections = status[provider.rawValue]["connections"].array.map { Connection(id: $0["id"].string, label: $0["label"].string) }
                busy = false
            } catch {
                guard attempt == id else { return }
                busy = false; self.error = "Could not finish connecting \(provider.name). Try again."
            }
        }
    }

    func disconnect(_ account: Connection) {
        guard !busy, let client else { return }
        busy = true; error = nil
        let id = UUID(); attempt = id
        task = Task {
            do {
                _ = try await client.json(path: "/v1/connectors/\(provider.rawValue)/loopback", method: "DELETE", body: .object(["connection_id": .string(account.id)]))
                guard attempt == id else { return }
                connections.removeAll { $0.id == account.id }; busy = false
            } catch {
                guard attempt == id else { return }
                busy = false; self.error = "Could not disconnect \(provider.name). Try again."
            }
        }
    }

    func cancelAuthorization() {
        guard receiver != nil else { return } // Safari closes before the broker exchange completes.
        attempt = UUID(); task?.cancel(); task = nil
        receiver?.stop(); receiver = nil; browser = nil; busy = false
    }

    func close() {
        cancelAuthorization()
        attempt = UUID(); task?.cancel(); task = nil
        client?.close(); client = nil; busy = false
    }
}

private struct SpotifyAuthorizationBrowser: UIViewControllerRepresentable {
    let url: URL
    let cancel: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(cancel: cancel) }
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.delegate = context.coordinator
        controller.dismissButtonStyle = .cancel
        return controller
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let cancel: () -> Void
        init(cancel: @escaping () -> Void) { self.cancel = cancel }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { cancel() }
    }
}

#if DEBUG
/// Exercises Safari's real HTTP redirect handling on iOS without real credentials.
struct SpotifyLoopbackSmokeView: View {
    private let provider: MusicLoopbackProvider
    @State private var receiver: SpotifyLoopbackReceiver
    init(provider: MusicLoopbackProvider = .spotify) {
        self.provider = provider
        _receiver = State(initialValue: SpotifyLoopbackReceiver(provider: provider))
    }
    @State private var ready = false
    @State private var browser = false
    @State private var result = "Starting listener"
    private let state = String(repeating: "s", count: 43)
    var body: some View {
        VStack {
            Text(result).accessibilityIdentifier("spotify-loopback-result")
            Button("Open callback in Safari") { browser = true }
                .disabled(!ready).accessibilityIdentifier("spotify-loopback-open")
        }
        .task {
            receiver.onCallback = { callback in
                result = callback.code == "fixture-code" ? "Callback received" : "Wrong callback"
                browser = false
                receiver.stop()
            }
            do {
                try await receiver.start(); receiver.expect(state: state)
                ready = true; result = "Listener ready"
            } catch { result = "Listener failed" }
        }
        .sheet(isPresented: $browser) {
            SpotifyAuthorizationBrowser(url: URL(string: "\(provider.redirectURI)?code=fixture-code&state=\(state)")!, cancel: { browser = false })
                .ignoresSafeArea()
        }
        .onDisappear { receiver.stop() }
    }
}
#endif

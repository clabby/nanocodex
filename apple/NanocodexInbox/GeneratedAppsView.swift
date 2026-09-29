import SwiftUI
import WebKit
import InboxCore
import NanocodexUI

struct GeneratedAppManifest: Identifiable, Equatable {
    let id: String
    let title: String
    let description: String
    let revision: Int
    let html: String

    init(_ json: JSON) throws {
        let id = json["id"].string
        guard id.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil,
              !json["title"].string.isEmpty,
              let revision = Int(exactly: json["revision"].number), revision > 0 else { throw APIError.invalidResponse }
        self.id = id; title = json["title"].string; description = json["description"].string
        self.revision = revision; html = json["html"].string
    }
}

struct GeneratedAppsView: View {
    @ObservedObject var model: InboxModel
    @Binding var selection: String?
    let create: () -> Void
    let openChat: () -> Void
    @State private var deleting: GeneratedAppManifest?
    @State private var error: String?

    var body: some View {
        Group {
            if let id = selection {
                GeneratedAppScreen(model: model, appID: id, back: { selection = nil }, openChat: openChat)
                    .id(model.screenScope + ":" + id)
            } else {
                List {
                    Section {
                        Button(action: create) { Label("Create an app", systemImage: "plus") }
                            .accessibilityIdentifier("create-generated-app")
                        Text("Describe an app. Your agent builds it here and saves its data to your account.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("Your apps") {
                        ForEach(model.generatedApps) { app in
                            Button { selection = app.id } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(app.title).font(.headline)
                                    if !app.description.isEmpty { Text(app.description).font(.caption).foregroundStyle(.secondary) }
                                }.foregroundStyle(.primary)
                            }
                            .swipeActions { Button("Delete", role: .destructive) { deleting = app } }
                        }
                        if model.generatedApps.isEmpty && !model.generatedAppsLoading {
                            Text("Your next idea belongs here.").foregroundStyle(.secondary)
                        }
                    }
                    if model.generatedAppsLoading { ProgressView("Loading apps…") }
                    if let message = error ?? model.generatedAppsError {
                        Section { Text(message).foregroundStyle(.red); Button("Retry") { Task { await model.refreshGeneratedApps() } } }
                    }
                }
                .refreshable { await model.refreshGeneratedApps() }
                .task { await model.refreshGeneratedApps() }
                .alert("Delete this app and its saved data?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                    Button("Cancel", role: .cancel) { deleting = nil }
                    Button("Delete", role: .destructive) {
                        guard let app = deleting else { return }; deleting = nil
                        let account = model.generatedAppAccount
                        Task {
                            do {
                                _ = try await model.generatedAppRequest(id: app.id, account: account, method: "DELETE", body: .object(["revision": .number(Double(app.revision))]))
                                await model.refreshGeneratedApps()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }
        }
    }
}

struct CreateGeneratedAppSheet: View {
    @ObservedObject var model: InboxModel
    var app: GeneratedAppManifest? = nil
    let created: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section(app == nil ? "What would you like to make?" : "What would you like to change?") {
                    TextField("A tracker, a planner, a tiny tool…", text: $prompt, axis: .vertical)
                        .lineLimit(5...12).accessibilityIdentifier("generated-app-prompt")
                }
                Section { Text("Your agent will build a custom app. Follow its progress in Chat, then open the finished app from the selector.").font(.footnote) }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(app == nil ? "Create an app" : "Edit app")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(app == nil ? "Create" : "Update") {
                        if model.createGeneratedApp(prompt: prompt, app: app) { dismiss(); created() }
                        else { error = "Couldn't start. Your request is still here." }
                    }.disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.utf8.count > 16_000)
                    .accessibilityIdentifier("submit-generated-app")
                }
            }
        }
    }
}

private struct GeneratedAppScreen: View {
    @ObservedObject var model: InboxModel
    let appID: String
    let back: () -> Void
    let openChat: () -> Void
    @State private var showEdit = false
    @State private var app: GeneratedAppManifest?
    @State private var error: String?
    @State private var loading = true
    @State private var running = false
    @State private var runtimeKey = UUID()
    @State private var account: UUID?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: back) { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("All apps")
                Text(app?.title ?? "App").font(.headline).lineLimit(1)
                Spacer()
                Button { showEdit = true } label: { Image(systemName: "pencil").frame(width: 44, height: 44) }
                    .accessibilityLabel("Edit app with a prompt").disabled(app == nil)
                Menu {
                    Button("Reload", systemImage: "arrow.clockwise") { runtimeKey = UUID(); Task { await load() } }
                    Button("Restore previous version", systemImage: "arrow.uturn.backward") {
                        guard let app, let account else { return }
                        Task {
                            do {
                                _ = try await model.generatedAppRequest(id: appID, account: account, restore: true, method: "POST",
                                    body: .object(["revision": .number(Double(app.revision))]))
                                runtimeKey = UUID(); await load(); await model.refreshGeneratedApps()
                            } catch { self.error = error.localizedDescription }
                        }
                    }.disabled((app?.revision ?? 1) <= 1)
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                    .accessibilityLabel("App options")
            }.padding(.horizontal, 8)
            if loading { ProgressView("Opening app…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if let app, let account {
                GeneratedAppWebView(html: app.html, request: { method, input in
                    let body = try JSONDecoder().decode(JSON.self, from: input)
                    let result: JSON
                    do {
                    switch method {
                    case "data.get": result = try await model.generatedAppRequest(id: appID, account: account, data: true)
                    case "data.set": result = try await model.generatedAppRequest(id: appID, account: account, data: true, method: "PUT", body: body)
                    case "agent.request":
                        let prompt = body["prompt"].string
                        guard !prompt.isEmpty, prompt.utf8.count <= 16 * 1024, !running,
                              model.generatedAppAccount == account else { throw APIError.invalidResponse }
                        running = true
                        defer { running = false }
                        result = try await model.runGeneratedAppAgent(id: appID, title: app.title, purpose: app.description, prompt: prompt, account: account)
                    default: throw APIError.invalidResponse
                    }
                    return try JSONEncoder().encode(result)
                    } catch APIError.http(409) {
                        throw GeneratedAppRuntime.HostError(code: "revision_conflict", message: "Saved data changed. Read the current value before retrying.")
                    } catch APIError.http(404) {
                        throw GeneratedAppRuntime.HostError(code: "not_found", message: "This app or agent is no longer available.")
                    } catch APIError.http(401), APIError.http(403), APIError.invalidCredential {
                        throw GeneratedAppRuntime.HostError(code: "unauthorized", message: "Reconnect your account to continue.")
                    } catch is CancellationError {
                        throw GeneratedAppRuntime.HostError(code: "cancelled", message: "The app request was cancelled.")
                    } catch {
                        throw GeneratedAppRuntime.HostError(code: "request_failed", message: "The app request failed. Try again.")
                    }
                }, failure: { error = $0 }).id(runtimeKey)
            } else { Spacer() }
            if running { Text("Agent working. This conversation is also available in Chat.").font(.footnote).padding(8) }
            if let error { Text(error).font(.footnote).foregroundStyle(.red).padding(8) }
        }
        .task { await load() }
        .sheet(isPresented: $showEdit) {
            CreateGeneratedAppSheet(model: model, app: app, created: openChat)
        }
    }

    private func load() async {
        loading = true; error = nil
        let epoch = model.generatedAppAccount
        do {
            let response = try await model.generatedAppRequest(id: appID, account: epoch)
            app = try GeneratedAppManifest(response); account = epoch
        } catch { app = nil; self.error = error.localizedDescription }
        loading = false
    }
}

// The runtime lives in NanocodexUI so the same executable WebKit boundary can be
// exercised by a macOS journey test as well as by the iPhone app.
private struct GeneratedAppWebView: UIViewRepresentable {
    let html: String
    let request: @MainActor (String, Data) async throws -> Data
    let failure: @MainActor (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        context.coordinator.start(in: container, html: html, request: request, failure: failure)
        return container
    }
    func updateUIView(_ view: UIView, context: Context) {}
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.stop() }

    @MainActor final class Coordinator {
        var runtime: GeneratedAppRuntime?
        var setup: Task<Void, Never>?
        func start(in container: UIView, html: String,
                   request: @escaping @MainActor (String, Data) async throws -> Data,
                   failure: @escaping @MainActor (String) -> Void) {
            setup = Task {
                do {
                    let runtime = try await GeneratedAppRuntime(request: request, failure: failure)
                    guard !Task.isCancelled else { runtime.invalidate(); return }
                    self.runtime = runtime
                    let webView = runtime.webView
                    webView.translatesAutoresizingMaskIntoConstraints = false
                    container.addSubview(webView)
                    NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                        webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                        webView.topAnchor.constraint(equalTo: container.topAnchor),
                        webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
                    runtime.load(html: html)
                } catch { if !Task.isCancelled { failure(error.localizedDescription) } }
            }
        }
        func stop() { setup?.cancel(); runtime?.invalidate(); runtime = nil }
    }
}

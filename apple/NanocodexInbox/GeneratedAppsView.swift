import SwiftUI
import InboxCore
import NanocodexUI
import NanocodexApps

struct GeneratedAppManifest: Identifiable, Equatable {
    let id: String
    let title: String
    let description: String
    let revision: Int
    let source: String

    init(_ json: JSON) throws {
        let id = json["id"].string
        guard id.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil,
              !json["title"].string.isEmpty, json["runtime"].string == "swift-v1",
              let revision = Int(exactly: json["revision"].number), revision > 0 else { throw APIError.invalidResponse }
        self.id = id; title = json["title"].string; description = json["description"].string
        self.revision = revision; source = json["source"].string
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
    var diagnostic: String? = nil
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
                        if model.createGeneratedApp(prompt: prompt, app: app, diagnostic: diagnostic) { dismiss(); created() }
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
    @State private var session: NativeAppSession?
    @State private var store: GeneratedAppStore?
    @State private var error: String?
    @State private var loading = false
    @State private var loadID = UUID()
    @State private var recoveryPrompt: String?
    @State private var confirmNewAttempt = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: back) { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                    .accessibilityLabel("All apps")
                Text(app?.title ?? "App").font(.headline).lineLimit(1)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button { showEdit = true } label: { Image(systemName: "pencil").frame(width: 44, height: 44) }
                    .accessibilityLabel("Edit app with a prompt").disabled(app == nil)
                Menu {
                    Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } }
                    Button("Restore previous version", systemImage: "arrow.uturn.backward") {
                        guard let app else { return }
                        let account = model.generatedAppAccount
                        Task {
                            do {
                                _ = try await model.generatedAppRequest(id: appID, account: account, restore: true, method: "POST",
                                    body: .object(["revision": .number(Double(app.revision))]))
                                await load(); await model.refreshGeneratedApps()
                            } catch { self.error = error.localizedDescription }
                        }
                    }.disabled((app?.revision ?? 1) <= 1 || loading)
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                    .accessibilityLabel("App options")
            }.padding(.horizontal, 8)
            Divider()
            if let session {
                NativeAppView(session: session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loading {
                ProgressView("Opening app…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Couldn't open this app", systemImage: "app.badge",
                    description: Text("Try reloading, editing the app, or restoring its previous version."))
            }
            if recoveryPrompt != nil, let session {
                GeneratedAgentRecoveryControls(session: session, openChat: openChat,
                    newAttempt: { confirmNewAttempt = true })
            }
            if let error {
                VStack(alignment: .leading, spacing: 6) {
                    Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
                    HStack {
                        Button("Try again") { Task { await load() } }.disabled(loading)
                        Spacer()
                        Button("Edit app") { showEdit = true }.disabled(app == nil)
                    }.font(.footnote)
                }.padding(12).background(.regularMaterial)
                .accessibilityIdentifier("generated-app-error")
            }
        }
        .confirmationDialog("Start new agent work?", isPresented: $confirmNewAttempt, titleVisibility: .visible) {
            Button("Allow a new attempt") {
                guard let prompt = recoveryPrompt else { return }
                do {
                    try model.releaseGeneratedAppAgentReceipt(id: appID, prompt: prompt, account: model.generatedAppAccount)
                    recoveryPrompt = nil
                } catch { self.error = error.localizedDescription }
            }
        } message: {
            Text("Earlier work may already have had effects. Check it in Chat first. The next tap in this app will start new work instead of recovering the previous result.")
        }
        .task { await load() }
        .onDisappear {
            loadID = UUID()
            session?.invalidate(); session = nil
            store?.invalidate(); store = nil
        }
        .sheet(isPresented: $showEdit) {
            CreateGeneratedAppSheet(model: model, app: app, diagnostic: error ?? session?.diagnostic?.localizedDescription, created: openChat)
        }
    }

    @MainActor private func load() async {
        let ticket = UUID(); loadID = ticket
        loading = true; error = nil
        let epoch = model.generatedAppAccount
        defer { if loadID == ticket { loading = false } }
        var candidate: NativeAppSession?
        var candidateStore: GeneratedAppStore?
        do {
            let response = try await model.generatedAppRequest(id: appID, account: epoch)
            guard loadID == ticket, !Task.isCancelled else { return }
            let manifest = try GeneratedAppManifest(response)
            app = manifest // Retain restore/edit controls even if the new source is invalid.
            let adapter = GeneratedAppStore(model: model, app: manifest, account: epoch) { prompt in
                guard model.generatedAppAccount == epoch else { return }
                recoveryPrompt = prompt
            }
            candidateStore = adapter
            let replacement = try NativeAppSession(source: manifest.source, host: adapter.host)
            candidate = replacement
            try await replacement.start()
            guard loadID == ticket, model.generatedAppAccount == epoch, !Task.isCancelled else {
                replacement.invalidate(); adapter.invalidate(); return
            }
            // Only a validated, initialized app replaces the last working native view.
            session?.invalidate(); store?.invalidate()
            session = replacement; store = adapter; recoveryPrompt = nil
        } catch {
            candidate?.invalidate(); candidateStore?.invalidate()
            if loadID == ticket, model.generatedAppAccount == epoch, !Task.isCancelled {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Owns the persistence revision separately from the generated Swift program.
/// Account authentication and request paths never enter interpreted app state.
@MainActor
private final class GeneratedAppStore {
    private let model: InboxModel
    private let app: GeneratedAppManifest
    private let account: UUID
    private var revision: Double?
    private var active = true
    private var actionPrompts: [String] = []
    private let agentRecovery: (String?) -> Void

    init(model: InboxModel, app: GeneratedAppManifest, account: UUID, agentRecovery: @escaping (String?) -> Void) {
        self.model = model; self.app = app; self.account = account; self.agentRecovery = agentRecovery
    }
    func invalidate() { active = false }
    private func check() throws {
        guard active, model.generatedAppAccount == account, model.connected, !Task.isCancelled else {
            throw CancellationError()
        }
    }
    var host: NativeAppHost {
        NativeAppHost(loadState: { [self] in
            try check()
            let receipt = try await model.generatedAppRequest(id: app.id, account: account, data: true)
            try check()
            guard case .number(let version) = receipt["revision"], version >= 0,
                  version.rounded(.down) == version else { throw APIError.invalidResponse }
            revision = version
            if receipt["value"] == .null { return [:] }
            guard case .object = receipt["value"] else {
                throw GeneratedAppFailure("This app's saved data needs a migration. Edit the app to keep your existing records.")
            }
            return try JSONDecoder().decode([String: AppValue].self, from: JSONEncoder().encode(receipt["value"]))
        }, saveState: { [self] state in
            try check()
            guard let revision else { throw APIError.invalidResponse }
            let value = try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(state))
            do {
                let receipt = try await model.generatedAppRequest(id: app.id, account: account, data: true, method: "PUT",
                    body: .object(["value": value, "revision": .number(revision)]))
                try check()
                guard case .number(let next) = receipt["revision"], next == revision + 1 else { throw APIError.invalidResponse }
                self.revision = next
            } catch APIError.http(409) {
                throw GeneratedAppFailure("Your saved data changed on another device. Reload this app before trying again.")
            }
        }, runAgent: { [self] prompt in
            try check()
            actionPrompts.append(prompt)
            let receipt = try await model.runGeneratedAppAgent(id: app.id, title: app.title, purpose: app.description,
                prompt: prompt, account: account, isActive: { [weak self] in self?.active == true })
            try check()
            if ["completed", "failed", "cancelled"].contains(receipt["status"].string) { agentRecovery(prompt) }
            switch receipt["status"].string {
            case "completed": return receipt["result"].string
            case "pending": throw GeneratedAppFailure("Your agent is still working. Continue in Chat, or tap the same action again to check its result.")
            case "cancelled": throw GeneratedAppFailure("The agent task was cancelled.")
            default: throw GeneratedAppFailure("The agent task failed. Open Chat for details.")
            }
        }, beginAction: { [self] in
            actionPrompts = []
            agentRecovery(nil)
        }, commitAction: { [self] in
            guard active else { return }
            model.commitGeneratedAppAgentActions(id: app.id, prompts: actionPrompts, account: account)
            actionPrompts = []
            agentRecovery(nil)
        })
    }
}

private struct GeneratedAppFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private struct GeneratedAgentRecoveryControls: View {
    @ObservedObject var session: NativeAppSession
    let openChat: () -> Void
    let newAttempt: () -> Void
    var body: some View {
        HStack {
            Button("View agent work", action: openChat)
            Spacer()
            Button("Start a new attempt…", action: newAttempt)
        }.font(.footnote).padding(12).disabled(session.isBusy)
    }
}

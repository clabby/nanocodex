import SwiftUI
import InboxCore
import NanocodexUI
import WebKit
import QuickLook

/// Reusable reader. Pass a synthetic fixture with a nil client for UI journeys.
struct TodoMailThreadView: View {
    @StateObject private var store: TodoMailSession
    private let replyMessageID: String?
    private let inboxModel: InboxModel?
    private let onChat: () -> Void
    private let inboxItemID: String?
    @State private var assistant: InboxAIRequest?
    @State private var expanded: Set<String> = []
    @State private var composing = false
    @State private var previewURL: URL?
    @State private var downloading: String?
    @State private var attachmentError: String?

    init(client: ManagedClient?, inboxModel: InboxModel? = nil, onChat: @escaping () -> Void = {}, inboxItemID: String? = nil, connectionID: String, threadID: String, replyMessageID: String? = nil, fixture: TodoMailThread? = nil) {
        self.replyMessageID = replyMessageID; self.inboxModel = inboxModel; self.onChat = onChat; self.inboxItemID = inboxItemID
        _store = StateObject(wrappedValue: TodoMailSession(client: client, connectionID: connectionID, threadID: threadID, fixture: fixture))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let thread = store.thread {
                    Text(thread.subject.isEmpty ? "No subject" : thread.subject)
                        .font(.system(size: 27, weight: .bold)).tracking(-0.7)
                        .textSelection(.enabled).accessibilityIdentifier("mail-thread-subject")
                    if let model = inboxModel, let context = thread.peopleContext { InboxPeopleView(model: model, context: context) }
                    if let status = store.readingStatus { Text(status).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("mail-cached-status") }
                    HStack {
                        Text("\(thread.messages.count) messages").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button(expanded.count == thread.messages.count ? "Collapse all" : "Expand all") {
                            expanded = expanded.count == thread.messages.count ? [] : Set(thread.messages.map(\.id))
                        }.font(.caption.weight(.semibold)).accessibilityIdentifier("mail-expand-all")
                    }
                    ForEach(thread.messages) { message in messageCard(message) }
                    if let draft = store.draft, draft.status != "sent" {
                        Button { composing = true } label: {
                            HStack {
                                Image(systemName: "square.and.pencil")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(draft.isLocked ? "Check send status" : "Continue draft").font(.subheadline.weight(.semibold))
                                    Text(store.saveLabel).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(); Image(systemName: "chevron.right").font(.caption)
                            }.padding(14).background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 14))
                        }.buttonStyle(.plain).accessibilityIdentifier("mail-continue-draft")
                    }
                } else if store.loading {
                    ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(.top, 80)
                } else {
                    ContentUnavailableView("Conversation unavailable", systemImage: "envelope", description: Text(store.error ?? "Try loading this conversation again."))
                    Button("Try again") { Task { await store.load() } }.accessibilityIdentifier("mail-retry")
                }
                if let error = attachmentError { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("mail-attachment-error") }
                if let error = store.error, store.thread != nil { Text(error).font(.footnote).foregroundStyle(.red) }
            }.padding(18)
        }
        .background(ChatPalette.background)
        .navigationTitle("Conversation").navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("mail-thread-reader")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { composing = store.begin(mode: .compose) } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("Compose email").accessibilityIdentifier("mail-compose")
                    .disabled(!store.canBegin)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let message = store.thread?.messages.first(where: { $0.id == replyMessageID }) ?? store.thread?.messages.last {
                HStack(spacing: 10) {
                    draftButton(.reply, symbol: "arrowshape.turn.up.left", message: message)
                    draftButton(.replyAll, symbol: "arrowshape.turn.up.left.2", message: message)
                    draftButton(.forward, symbol: "arrowshape.turn.up.right", message: message)
                    if inboxModel != nil, let thread = store.thread {
                        InboxMailAIMenu { text in assistant = InboxAIRequest(id: inboxItemID ?? "mail:" + thread.connectionID + ":" + thread.id, context: mailAIContext(thread: thread, draft: store.draft, itemID: inboxItemID), instructions: text) }
                    }
                }.padding(.horizontal, 16).padding(.vertical, 10).background(.ultraThinMaterial)
            }
        }
        .task {
            await store.load()
            if let last = store.thread?.messages.first(where: { $0.id == replyMessageID }) ?? store.thread?.messages.last { expanded.insert(last.id) }
        }
        .refreshable { await store.load() }
        .sheet(isPresented: $composing) { TodoMailEditor(store: store, inboxModel: inboxModel, onChat: onChat) }
        .sheet(item: $assistant) { request in if let model = inboxModel { InboxAIRequestView(model: model, request: request, onChat: onChat) } }
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { previous, current in
            if let previous, previous != current { try? FileManager.default.removeItem(at: previous.deletingLastPathComponent()) }
        }
    }
    private func draftButton(_ mode: TodoMailDraftMode, symbol: String, message: TodoMailMessage) -> some View {
        Button { composing = store.begin(mode: mode, message: message) } label: {
            Label(mode.title, systemImage: symbol).font(.caption.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
        }.buttonStyle(.bordered)
            .disabled(!store.canBegin)
            .accessibilityIdentifier("mail-\(mode.rawValue)")
    }
    private func messageCard(_ message: TodoMailMessage) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                if expanded.contains(message.id) { expanded.remove(message.id) } else { expanded.insert(message.id) }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Text(String(message.from.prefix(1)).uppercased()).font(.headline)
                        .frame(width: 34, height: 34).background(Color.orange.opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 4) {
                        Text(message.from.isEmpty ? "Unknown sender" : message.from).font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary).multilineTextAlignment(.leading)
                        Text(message.date).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: expanded.contains(message.id) ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(.secondary)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("mail-message:\(message.id)")
            if expanded.contains(message.id) {
                VStack(alignment: .leading, spacing: 3) {
                    addressLine("To", message.to)
                    if !message.cc.isEmpty { addressLine("Cc", message.cc) }
                    if !message.bcc.isEmpty { addressLine("Bcc", message.bcc) }
                }.textSelection(.enabled)
                Divider()
                if !message.bodyText.isEmpty {
                    Text(message.bodyText).font(.body).lineSpacing(4).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("mail-body:\(message.id)")
                } else if !message.bodyHTML.isEmpty {
                    TodoMailSafeHTML(html: message.bodyHTML).frame(minHeight: 380)
                        .accessibilityIdentifier("mail-html:\(message.id)")
                    Text("Remote images and interactive content are blocked.").font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text("This message has no readable body.").font(.body).foregroundStyle(.secondary)
                }
                if message.bodyTruncated {
                    Text("Some message content could not be loaded. Refresh to try again.").font(.footnote).foregroundStyle(.orange)
                        .accessibilityIdentifier("mail-body-incomplete")
                }
                ForEach(message.attachments) { attachment in
                    Button {
                        Task {
                            downloading = attachment.id; attachmentError = nil
                            defer { downloading = nil }
                            do { previewURL = try await store.attachment(attachment, messageID: message.id) }
                            catch { attachmentError = error.localizedDescription }
                        }
                    } label: {
                        HStack {
                            Image(systemName: "paperclip")
                            VStack(alignment: .leading, spacing: 3) {
                                Text(attachment.filename).font(.subheadline).lineLimit(2)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file)).font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if downloading == attachment.id { ProgressView() } else { Image(systemName: "arrow.down.circle") }
                        }.padding(10).background(ChatPalette.background, in: RoundedRectangle(cornerRadius: 10))
                    }.buttonStyle(.plain).disabled(downloading != nil)
                        .accessibilityLabel("Open or save \(attachment.filename)")
                        .accessibilityIdentifier("mail-attachment:\(attachment.id)")
                }
            } else {
                Text(message.bodyText).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 16))
    }
    private func addressLine(_ label: String, _ value: String) -> some View {
        Text(label + ": " + value).font(.caption).foregroundStyle(.secondary)
    }
}

struct TodoMailComposeView: View {
    @StateObject private var store: TodoMailSession
    private let inboxModel: InboxModel?
    private let onChat: () -> Void
    init(client: ManagedClient?, inboxModel: InboxModel? = nil, onChat: @escaping () -> Void = {}, connectionID: String, draftID: String? = nil, fixture: Bool = false) {
        self.inboxModel = inboxModel; self.onChat = onChat
        _store = StateObject(wrappedValue: TodoMailSession(client: client, connectionID: connectionID, draftID: draftID, fixtureMode: fixture))
    }
    var body: some View {
        TodoMailEditor(store: store, inboxModel: inboxModel, onChat: onChat).task {
            await store.load()
            if store.draft == nil || store.draft?.status == "sent" { store.begin(mode: .compose) }
        }
    }
}

private struct TodoMailEditor: View {
    @ObservedObject var store: TodoMailSession
    var inboxModel: InboxModel? = nil
    var onChat: () -> Void = {}
    @State private var assistant: InboxAIRequest?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var reloadConfirmation = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let draft = store.draft {
                        if store.thread != nil {
                            Picker("Message type", selection: Binding(get: { draft.mode }, set: { store.changeMode($0) })) {
                                ForEach(TodoMailDraftMode.allCases, id: \.self) { Text($0.title).tag($0) }
                            }.pickerStyle(.menu).font(.subheadline).padding(.vertical, 6)
                                .accessibilityIdentifier("mail-draft-mode")
                        }
                        HStack(alignment: .firstTextBaseline) {
                            Text("From").font(.subheadline).foregroundStyle(.secondary).frame(width: 58, alignment: .leading)
                            Text(store.senderAddress.isEmpty ? "Sender unavailable · refresh the conversation" : store.senderAddress)
                                .font(.subheadline).textSelection(.enabled)
                        }.padding(.vertical, 12).accessibilityIdentifier("mail-draft-from")
                        Divider()
                        recipientField("To", keyPath: \.to)
                        recipientField("Cc", keyPath: \.cc)
                        recipientField("Bcc", keyPath: \.bcc)
                        HStack {
                            Text("Subject").font(.subheadline).foregroundStyle(.secondary).frame(width: 58, alignment: .leading)
                            TextField("Subject", text: binding(\.subject)).font(.subheadline)
                                .accessibilityIdentifier("mail-draft-subject")
                        }.padding(.vertical, 12)
                        Divider()
                        if draft.mode == .reply || draft.mode == .replyAll {
                            Button { Task { await store.suggestReply() } } label: {
                                HStack {
                                    if store.suggesting { ProgressView().controlSize(.mini) }
                                    Label("Draft for me", systemImage: "sparkles")
                                }
                            }.disabled(!store.canSuggest).padding(.top, 12)
                                .accessibilityIdentifier("mail-draft-suggest")
                            Text("Creates an editable suggestion when the message body is empty.")
                                .font(.caption).foregroundStyle(.secondary).padding(.top, 4)
                        }
                        TextEditor(text: binding(\.bodyText)).frame(minHeight: 280)
                            .scrollContentBackground(.hidden).padding(.top, 10)
                            .accessibilityLabel("Message body").accessibilityIdentifier("mail-draft-body")
                        if draft.mode == .forward {
                            Text("Original attachments are available in the conversation. Forwarding includes the message text.")
                                .font(.caption).foregroundStyle(.secondary).padding(.vertical, 8)
                        }
                        HStack(spacing: 6) {
                            if store.saving { ProgressView().controlSize(.mini) }
                            Image(systemName: draft.status == "sent" ? "checkmark.circle.fill" : "lock.shield")
                            Text(store.saveLabel)
                        }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 12)
                            .accessibilityIdentifier("mail-draft-status")
                    } else if store.error == nil {
                        ProgressView("Loading draft…").padding(40)
                    } else {
                        Button("Try again") {
                            Task {
                                await store.load()
                                if store.draft == nil || store.draft?.status == "sent" { store.begin(mode: .compose) }
                            }
                        }.accessibilityIdentifier("mail-retry-draft").padding(.vertical, 12)
                    }
                    if let error = store.error {
                        Text(error).font(.footnote).foregroundStyle(.red).padding(.vertical, 8)
                            .accessibilityIdentifier("mail-draft-error")
                    }
                    if let receipt = store.receiptSnapshot, store.dirty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Separate server receipt · " + receipt.status).font(.headline)
                            Text("To: " + receipt.to.joined(separator: ", ")).font(.caption)
                            Text(receipt.subject).font(.subheadline)
                            Text(receipt.bodyText).textSelection(.enabled)
                            Text("The editable text above is retained locally and was not sent.").font(.caption)
                        }.padding(.vertical, 12).accessibilityIdentifier("mail-server-receipt")
                    }
                    if store.conflicted && !store.hasLockedReceipt {
                        Button("Reload server draft…") { reloadConfirmation = true }
                            .accessibilityIdentifier("mail-reload-draft").padding(.vertical, 8)
                    }
                }.padding(.horizontal, 18)
                    .disabled(store.sending || store.draft?.isLocked == true)
                // A status check is read-only and must remain available for a locked draft.
                if store.draft?.isLocked == true {
                    Button("Refresh status") { Task { await store.refreshSendStatus() } }
                        .accessibilityIdentifier("mail-refresh-send-status").padding()
                }
            }.background(ChatPalette.background)
                .navigationTitle(store.draft?.mode.title ?? "Draft").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { Task { await store.flush(); dismiss() } }
                            .disabled(store.sending).accessibilityIdentifier("mail-draft-done")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { Task { await store.send() } } label: {
                            if store.sending { ProgressView() } else { Text("Send").fontWeight(.semibold) }
                        }.disabled(!store.canSend).accessibilityLabel("Send email").accessibilityIdentifier("mail-send")
                    }
                }
                .confirmationDialog("Replace this device’s edits with the server draft?", isPresented: $reloadConfirmation, titleVisibility: .visible) {
                    Button("Reload server draft", role: .destructive) { Task { await store.reloadServerDraft() } }
                }
                .safeAreaInset(edge: .bottom) {
                    if inboxModel != nil, let draft = store.draft {
                        HStack {
                            Text("Prepare or improve this draft").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            InboxMailAIMenu { text in assistant = InboxAIRequest(id: "draft:" + draft.id, context: mailAIContext(thread: store.thread, draft: draft), instructions: text) }
                                .disabled(store.sending || draft.isLocked)
                        }.padding(.horizontal, 18).background(.regularMaterial)
                    }
                }
                .sheet(item: $assistant) { request in if let model = inboxModel { InboxAIRequestView(model: model, request: request, onChat: onChat) } }
                .interactiveDismissDisabled(store.sending)
                .onChange(of: scenePhase) { _, phase in if phase != .active { Task { await store.flush() } } }
                .onDisappear { Task { await store.flush() } }
        }.accessibilityIdentifier("mail-draft-editor")
    }
    private func recipientField(_ title: String, keyPath: WritableKeyPath<TodoMailDraft, [String]>) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.subheadline).foregroundStyle(.secondary).frame(width: 58, alignment: .leading)
                TextField("name@example.com", text: Binding(get: { store.draft?[keyPath: keyPath].joined(separator: ", ") ?? "" }, set: { value in
                    store.edit { $0[keyPath: keyPath] = value.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } }
                }), axis: .vertical)
                .font(.subheadline).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("mail-draft-\(title.lowercased())")
            }.padding(.vertical, 12)
            Divider()
        }
    }
    private func binding(_ keyPath: WritableKeyPath<TodoMailDraft, String>) -> Binding<String> {
        Binding(get: { store.draft?[keyPath: keyPath] ?? "" }, set: { value in store.edit { $0[keyPath: keyPath] = value } })
    }
}

/// The reader has no bridge, account cookies, JavaScript, external resources, or navigation.
private struct TodoMailSafeHTML: UIViewRepresentable {
    let html: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.allowsLinkPreview = false
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        let content = html
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "TodoMailBlockAllNetwork-v1", encodedContentRuleList: "[{\"trigger\":{\"url-filter\":\".*\"},\"action\":{\"type\":\"block\"}}]") { rules, _ in
            guard let rules, context.coordinator.loadedHTML == content else { return }
            view.configuration.userContentController.add(rules)
            view.loadHTMLString("""
            <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'"><style>:root{color-scheme:light dark}body{font:17px -apple-system;margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap}img,iframe,object,embed,form{display:none!important}a{pointer-events:none;color:inherit}</style></head><body>\(content)</body></html>
            """, baseURL: nil)
        }
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML: String?
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Only the locally supplied initial document is admitted. Redirects,
            // custom schemes, user links, frames, downloads, and form submits fail closed.
            let initial = navigationAction.navigationType == .other && navigationAction.request.url?.absoluteString == "about:blank" && navigationAction.targetFrame?.isMainFrame == true
            decisionHandler(initial ? .allow : .cancel)
        }
    }
}


/// Read-only prepared content, using the very same recovery, conflict and
/// idempotent send session as the manual mail editor. No suggestion on open.
struct PreparedDecisionMailView: View {
    @StateObject private var store: TodoMailSession
    let approvalBlocked: Bool
    @Binding var busy: Bool
    init(client: ManagedClient?, decision: TodoDecision, draft: TodoMailDraft, fixture: Bool, approvalBlocked: Bool, busy: Binding<Bool>) {
        self.approvalBlocked = approvalBlocked; _busy = busy
        var fixtureAuthority = fixture
        #if DEBUG && targetEnvironment(simulator)
        // Isolated UI fixture: display the cached proposal with no client and
        // no synthetic approval authority. Never enabled on a physical device.
        if fixture && ProcessInfo.processInfo.arguments.contains("--decision-cached-readonly-fixture") { fixtureAuthority = false }
        #endif
        _store = StateObject(wrappedValue: TodoMailSession(client: client, connectionID: draft.connectionID,
            draftID: draft.id, fixtureMode: fixtureAuthority, preparedDraft: draft, preparedDecision: decision))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Complete draft").font(.headline)
            if let draft = store.draft {
                Text("From: " + (store.senderAddress.isEmpty ? "Checking sender…" : store.senderAddress)).font(.caption).foregroundStyle(.secondary)
                Text("To: " + draft.to.joined(separator: ", ")).font(.subheadline)
                if !draft.cc.isEmpty { Text("Cc: " + draft.cc.joined(separator: ", ")).font(.subheadline) }
                if !draft.bcc.isEmpty { Text("Bcc: " + draft.bcc.joined(separator: ", ")).font(.subheadline) }
                Text(draft.subject).font(.subheadline.weight(.semibold))
                Text(draft.bodyText).textSelection(.enabled).accessibilityIdentifier("decision-complete-draft")
                Text("Account draft · version \(draft.version)").font(.caption2).foregroundStyle(.secondary)
                Text(store.saveLabel).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("decision-send-status")
                Button {
                    let reviewed = draft
                    Task { await store.send(reviewed: reviewed) }
                } label: {
                    if store.sending { ProgressView("Submitting approval…") }
                    else { Text("Approve & send") }
                }.buttonStyle(.borderedProminent).tint(.primary)
                    .disabled(!store.canSend || approvalBlocked || draft.version < 1)
                    .accessibilityIdentifier("decision-approve-send")
                if store.conflicted {
                    Text("The server draft changed. Your prior text is preserved. Reload, then review the complete current version.").font(.caption).foregroundStyle(.orange)
                    Text("Close this page, refresh the inbox, and reopen the current prepared decision.").font(.caption)
                }
                if draft.isLocked { Button("Check send status") { Task { await store.refreshSendStatus() } } }
            }
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("decision-mail-error") }
            Text("Approval applies only to the recipients and complete version shown. Provider acceptance is not verified delivery.")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 14))
            .task { await store.load() }
            .onChange(of: store.sending) { _, value in busy = value }
            .onDisappear { Task { await store.waitForRecovery() } }
    }
}

/// Source-qualified, bounded snapshots let preparation fetch the originals;
/// quoted message content is not authority to execute anything.
private func mailAIContext(thread: TodoMailThread?, draft: TodoMailDraft?, itemID: String? = nil) -> JSON {
    var fields: [String: JSON] = ["coverage": .string("Retained mail/draft snapshot; verify current conversation and CRM identity. This is preparation only.")]
    if let thread {
        fields["item_id"] = .string(itemID ?? "mail:" + thread.connectionID + ":" + thread.id)
        fields["title"] = .string(thread.subject); fields["connection_id"] = .string(thread.connectionID); fields["thread_id"] = .string(thread.id)
        fields["crm"] = thread.peopleContext?.referenceSnapshot ?? .null
        fields["messages"] = .array(thread.messages.suffix(3).map { .object([
            "message_id": .string($0.id), "from": .string($0.from), "to": .string($0.to), "subject": .string($0.subject),
            "body_excerpt": .string(String($0.bodyText.prefix(4000))), "body_truncated": .bool($0.bodyTruncated || $0.bodyText.count > 4000)
        ]) })
    }
    if let draft {
        if itemID == nil { fields["item_id"] = .string("draft:" + draft.id) }
        fields["title"] = .string(draft.subject.isEmpty ? "Unfinished draft" : draft.subject)
        fields["draft"] = .object(["id": .string(draft.id), "connection_id": .string(draft.connectionID), "version": .number(Double(draft.version)), "to": .array(draft.to.map(JSON.string)), "subject": .string(draft.subject), "body": .string(String(draft.bodyText.prefix(8000))), "status": .string(draft.status)])
    }
    return .object(fields)
}
private struct InboxMailAIMenu: View {
    let prepare: (String) -> Void
    var body: some View {
        Menu {
            Button("Brief me") { prepare("Brief me on this conversation, what needs a response, and verified CRM context. Flag missing or stale facts.") }
            Button("Draft reply") { prepare("Prepare an editable reply using the current source conversation and verified CRM people. Preserve any existing draft text; do not send.") }
            Button("Prepare next steps") { prepare("Prepare complete next steps for my review using the current conversation and linked CRM context. Do not execute external actions.") }
            Button("Ask something else") { prepare("") }
        } label: { Image(systemName: "sparkles").frame(width: 44, height: 44) }
            .accessibilityLabel("AI actions for this email").accessibilityIdentifier("mail-ai-actions")
    }
}

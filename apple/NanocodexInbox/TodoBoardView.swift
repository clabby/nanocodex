import SwiftUI
import InboxCore
import NanocodexUI

/// A decision inbox, not a second prompt screen. Capture lives in the fixed bottom dock.
struct TodoBoardView: View {
    @ObservedObject var model: InboxModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedDecision: TodoDecision?
    private var filter: TodoFeedFilter { model.todoFilter }

    var body: some View {
        List {
            let feed = TodoFeed(captures: model.todoItems, decisions: model.todoDecisions,
                                traces: model.todoTraces, filter: filter)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("TODO")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .tracking(-1.5)
                    Spacer()
                    let pending = model.todoDecisions.filter { $0.status == "needs_you" }.count
                    if pending > 0 {
                        Text("\(pending) to decide")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Color.orange.opacity(0.09), in: Capsule())
                    }
                }
            }
            .padding(.top, 8).padding(.bottom, 6)
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)

            Picker("Show", selection: $model.todoFilter) {
                ForEach(TodoFeedFilter.allCases, id: \.self) { value in
                    Text(value.rawValue).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("todo-filter")
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            let visible = feed.decisions
            if visible.isEmpty && feed.traces.isEmpty && !model.todoLoaded {
                emptyState(title: model.todoError == nil ? "Finding your next move" : "Couldn't load decisions",
                           detail: model.todoError == nil ? "Your decisions will appear here shortly." : "Pull down to try again.",
                           symbol: "tray")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            } else if visible.isEmpty && feed.traces.isEmpty {
                emptyState(title: filter == .ignore ? "Nothing ignored" : "You're all caught up",
                           detail: filter == .ignore ? "No ignored results in the recent feed" : "Nothing needs your decision right now",
                           symbol: "checkmark")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("todo-no-decisions")
            } else {
                ForEach(visible) { decision in
                    decisionCard(decision)
                        .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            if decision.status == "needs_you", let choice = decision.choices.first {
                                Button {
                                    Task { _ = await model.respondTodo(to: decision, choiceID: choice.id, text: nil) }
                                } label: { Label(choice.title, systemImage: "checkmark") }
                                    .tint(.orange).disabled(model.todoResponding)
                                    .accessibilityIdentifier("decision-swipe-primary:\(decision.id)")
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if decision.status == "needs_you", decision.choices.count > 1 {
                                let choice = decision.choices[1]
                                Button {
                                    Task { _ = await model.respondTodo(to: decision, choiceID: choice.id, text: nil) }
                                } label: { Label(choice.title, systemImage: "arrow.uturn.backward") }
                                    .tint(.orange).disabled(model.todoResponding)
                                    .accessibilityIdentifier("decision-swipe-secondary:\(decision.id)")
                            }
                        }
                }
            }
            if !feed.traces.isEmpty {
                Section {
                    ForEach(feed.traces) { trace in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(trace.outcomeLabel).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            Text(trace.title).font(.headline)
                            if !trace.sender.isEmpty { Text(trace.sender).font(.subheadline).foregroundStyle(.secondary) }
                            Text(trace.reasonLabel).font(.subheadline).foregroundStyle(.secondary)
                            if trace.subject.isEmpty && trace.sender.isEmpty {
                                Text("Message details were not recorded for this result.").font(.caption).foregroundStyle(.secondary)
                            }
                            if let date = trace.observedAt { Text(date, style: .date).font(.caption2).foregroundStyle(.secondary) }
                            if let url = trace.sourceURL {
                                Link("Open source", destination: url).font(.caption)
                                    .frame(minHeight: 44)
                            }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 14))
                        .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("todo-trace:\(trace.id)")
                    }
                } header: { sectionHeading("Recent email results", count: feed.traces.count) }
                  footer: { Text("Up to 100 recent results from the last 90 days.") }
            }
            if !feed.captures.isEmpty {
                Section {
                    ForEach(feed.captures) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.body).font(.body)
                            if !item.watchHint.isEmpty {
                                Text("Watch for: " + item.watchHint).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(item.status == "watching" ? "Watching" : item.status.capitalized)
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 14))
                        .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                } header: { sectionHeading("Captured", count: feed.captures.count) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(ChatPalette.background)
        .refreshable { await model.refreshTodo() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await model.refreshTodo()
                do { try await Task.sleep(for: .seconds(15)) }
                catch { return }
            }
        }
        .sheet(item: $selectedDecision) { decision in
            DecisionDetailView(decision: decision, model: model)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(28)
        }
    }

    private func sectionHeading(_ title: String, count: Int) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.system(size: 16, weight: .semibold))
            Spacer()
            Text(count, format: .number).font(.caption.monospacedDigit())
        }
        .foregroundStyle(.secondary)
        .textCase(nil)
        .padding(.top, 8).padding(.bottom, 4)
    }

    private func emptyState(title: String, detail: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .light))
                .frame(width: 48, height: 48)
                .background(ChatPalette.userBubble, in: Circle())
            Text(title).font(.title2.weight(.semibold))
            Text(detail).font(.subheadline).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).padding(.vertical, 8)
    }

    private func decisionCard(_ decision: TodoDecision) -> some View {
        Button { selectedDecision = decision } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(decision.sourceLabel.isEmpty ? "Decision" : decision.sourceLabel)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(decision.status == "needs_you" ? "Pending" : decision.status.capitalized)
                            .foregroundStyle(decision.status == "needs_you" ? Color.orange : Color.secondary)
                    }
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    Text(decision.title)
                        .font(.headline).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if !decision.context.isEmpty {
                        Text(decision.context).font(.subheadline).foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading).lineLimit(2)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.055)))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("decision-card:" + decision.id)
    }
}

/// Composer and tab switch share one bottom safe-area dock, so neither overlays the other.
struct TodoCaptureComposer: View {
    @ObservedObject var model: InboxModel
    @Binding var inputFocused: Bool
    @State private var captureFocused = false
    @State private var overflowing = false
    @FocusState private var hintFocused: Bool
    @State private var hintExpanded = false

    private var canSave: Bool {
        !model.todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && model.todoDraft.utf8.count <= 4096 && !model.todoSaving
    }

    var body: some View {
        VStack(spacing: 0) {
            if let error = model.todoError {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.top, 10)
            }
            if hintExpanded || !model.todoWatchHint.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "eye").foregroundStyle(.secondary)
                    TextField("Watch for…", text: $model.todoWatchHint)
                        .focused($hintFocused).font(.subheadline)
                        .accessibilityIdentifier("todo-watch-hint")
                    Button { hintFocused = false; hintExpanded = false; model.todoWatchHint = "" } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }.accessibilityLabel("Clear watch hint")
                }
                .padding(.leading, 16).padding(.trailing, 4)
            }
            HStack(alignment: .bottom, spacing: 2) {
                Button { hintExpanded.toggle(); if hintExpanded { hintFocused = true } } label: {
                    Image(systemName: hintExpanded || !model.todoWatchHint.isEmpty ? "eye.fill" : "plus")
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Watch for a signal")
                .accessibilityIdentifier("todo-watch-toggle")
                ChatComposerEditor(text: $model.todoDraft, focused: $captureFocused,
                                   overflowing: $overflowing, accessibilityLabel: "On your mind")
                    .accessibilityIdentifier("todo-capture")
                    .overlay(alignment: .topLeading) {
                        if model.todoDraft.isEmpty {
                            Text("On your mind…").font(.body).foregroundStyle(.tertiary)
                                .padding(.top, 8).allowsHitTesting(false).accessibilityHidden(true)
                        }
                    }
                Button {
                    captureFocused = false; hintFocused = false
                    Task { await model.saveTodo() }
                } label: {
                    Group {
                        if model.todoSaving { ProgressView().tint(Color(uiColor: .systemBackground)) }
                        else { Image(systemName: "arrow.up") }
                    }
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 32, height: 32)
                    .background(Color.primary.opacity(canSave ? 1 : 0.22), in: Circle())
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!canSave)
                .accessibilityLabel("Save thought").accessibilityIdentifier("todo-capture-save")
            }
            .padding(.horizontal, 4).padding(.bottom, 4).padding(.top, 4)
        }
        .modifier(InboxComposerShell(focused: inputFocused))
        .frame(maxWidth: 620)
        .onChange(of: captureFocused) { _, _ in inputFocused = captureFocused || hintFocused }
        .onChange(of: hintFocused) { _, _ in inputFocused = captureFocused || hintFocused }
        .onDisappear { inputFocused = false }
    }
}

private struct DecisionDetailView: View {
    let decision: TodoDecision
    @ObservedObject var model: InboxModel
    @Environment(\.dismiss) private var dismiss
    @State private var instructions = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Label(decision.sourceLabel.isEmpty ? "Decision" : decision.sourceLabel, systemImage: "sparkle")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(decision.title).font(.system(size: 24, weight: .semibold)).tracking(-0.4)
                    Text(decision.context).font(.body).foregroundStyle(.secondary)
                    if let todoID = decision.todoID,
                       let thought = model.todoItems.first(where: { $0.id == todoID }) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("From your capture").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(thought.body).font(.subheadline)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 12))
                    }
                    if let url = decision.sourceURL {
                        Link(destination: url) {
                            Label("Open source", systemImage: "arrow.up.right.square")
                        }.frame(minHeight: 44).accessibilityIdentifier("decision-source")
                    }
                    if decision.status == "needs_you" {
                        ForEach(decision.choices) { choice in
                            Button {
                                Task {
                                    if await model.respondTodo(to: decision, choiceID: choice.id, text: nil) { dismiss() }
                                }
                            } label: {
                                HStack {
                                    Text(choice.title)
                                    Spacer()
                                    Image(systemName: "arrow.right")
                                }
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .frame(minHeight: 44)
                                .background(ChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain).disabled(model.todoResponding)
                            .accessibilityIdentifier("decision-choice:\(decision.id):\(choice.id)")
                        }
                        Text("Edit or give instructions").font(.subheadline.weight(.semibold)).padding(.top, 4)
                        TextEditor(text: $instructions)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 80).padding(6)
                            .background(ChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("decision-instructions")
                        Button("Submit instructions") {
                            Task {
                                if await model.respondTodo(to: decision, choiceID: nil,
                                                           text: instructions.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() }
                            }
                        }
                        .frame(minHeight: 44)
                        .buttonStyle(.borderedProminent).tint(.primary)
                        .disabled(instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.todoResponding)
                        if let error = model.todoError { Text(error).font(.caption).foregroundStyle(.orange) }
                    } else {
                        Label(decision.status == "answered" ? "Answer recorded; waiting for the workflow" : "This decision is no longer open",
                              systemImage: "checkmark.circle")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(16).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(ChatPalette.background)
            .navigationTitle("Decision").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }.accessibilityIdentifier("decision-detail-close")
            } }
        }
    }
}

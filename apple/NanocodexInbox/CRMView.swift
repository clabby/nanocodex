import SwiftUI
import InboxCore
import NanocodexUI

struct CRMView: View {
    @ObservedObject var model: InboxModel
    @State private var query = ""
    @State private var kind = "person"
    @State private var records: [JSON] = []
    @State private var cursor = ""
    @State private var loading = false
    @State private var error: String?
    @State private var revision = 0
    private var searchKey: String { "\(kind):\(query):\(revision)" }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                Text("CRM").font(.system(.title, design: .rounded, weight: .bold)).padding(.top, 10)
                VStack(spacing: 8) {
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("Search your CRM", text: $query)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("crm-search")
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                                .accessibilityLabel("Clear search")
                        }
                    }
                    .padding(12).background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 14))
                    HStack(spacing: 8) {
                        filterButton("People", value: "person", symbol: "person")
                        filterButton("Companies", value: "company", symbol: "building.2")
                        Spacer(minLength: 0)
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    VStack(spacing: 0) {
                        ForEach(records, id: \.crmID) { record in
                            NavigationLink { CRMProfileView(model: model, recordID: record.crmID) } label: {
                                HStack(spacing: 12) {
                                    CRMAvatar(name: record["name"].string, company: record["kind"].string == "company", size: 36)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(record["name"].string).font(.body.weight(.semibold)).foregroundStyle(.primary)
                                        if !record["title"].string.isEmpty { Text(record["title"].string).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                }.padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("crm-record-\(record.crmID)")
                            if record.crmID != records.last?.crmID { Divider().padding(.leading, 60) }
                        }
                    }.background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 16))
                    if loading { ProgressView().frame(maxWidth: .infinity).padding(24) }
                    if let error {
                        CRMEmptyState(symbol: "wifi.exclamationmark", title: "Couldn’t load your CRM", detail: error)
                        Button("Retry") { revision += 1 }.buttonStyle(.bordered).frame(maxWidth: .infinity)
                    } else if !loading && records.isEmpty {
                        CRMEmptyState(symbol: query.isEmpty ? "person.crop.rectangle.stack" : "magnifyingglass",
                            title: query.isEmpty ? "A little context goes a long way" : "No matches",
                            detail: query.isEmpty ? "Ask in chat to save someone. Their story and connections will live here." : "Try another name, company, or detail.")
                    }
                    if !cursor.isEmpty && !loading { Button("Load more") { Task { await load(more: true) } }.buttonStyle(.bordered).frame(maxWidth: .infinity) }
                }
            }.padding(.horizontal, 16).padding(.bottom, 28).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ChatPalette.background)
        .task(id: searchKey) { records = []; cursor = ""; error = nil; await load(more: false) }
        .refreshable { revision += 1 }
    }

    private func filterButton(_ title: String, value: String, symbol: String) -> some View {
        Button { kind = value } label: {
            Label(title, systemImage: symbol).font(.subheadline.weight(.medium))
                .padding(.horizontal, 16).frame(minHeight: 44)
                .foregroundStyle(kind == value ? ChatPalette.background : Color.primary)
                .background(kind == value ? Color.primary : ChatPalette.composer, in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(kind == value ? .isSelected : [])
            .accessibilityIdentifier("crm-filter-\(value)")
    }
    @MainActor private func load(more: Bool) async {
        let key = searchKey
        loading = true; error = nil
        defer { if key == searchKey { loading = false } }
        do {
            if !more { try await Task.sleep(for: .milliseconds(200)) }
            let result = try await model.crmRead(query: ["q": query, "kind": kind, "cursor": more ? cursor : ""])
            try Task.checkCancellation()
            guard key == searchKey else { return }
            if case .array(let rows) = result["records"] {
                records = more ? records + rows.filter { row in !records.contains { $0.crmID == row.crmID } } : rows
                cursor = result["next_cursor"].string
            } else { throw APIError.invalidResponse }
        } catch is CancellationError {} catch {
            if key == searchKey { self.error = error.localizedDescription }
        }
    }
}

private struct CRMAvatar: View {
    let name: String
    var company = false
    var size: CGFloat = 46
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.32).fill(Color.primary.opacity(0.055))
            if company { Image(systemName: "building.2").font(.system(size: size * 0.36, weight: .medium)) }
            else { Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined())
                    .font(.system(size: size * 0.32, weight: .semibold, design: .rounded)) }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

private struct CRMEmptyState: View {
    let symbol: String
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 28, weight: .light)).foregroundStyle(.secondary).padding(.bottom, 4)
            Text(title).font(.headline)
            Text(detail).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 40)
    }
}

private struct CRMProfileView: View {
    @ObservedObject var model: InboxModel
    let recordID: String
    @State private var detail: JSON = .null
    @State private var pages: [String: [JSON]] = [:]
    @State private var cursors: [String: String] = [:]
    @State private var loading = false
    @State private var error: String?
    @State private var revision = 0

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if detail != .null {
                    hero
                    if !detail["research"]["summary"].string.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            sectionHeading("About", symbol: "text.alignleft")
                            Text(detail["research"]["summary"].string).font(.subheadline).foregroundStyle(.secondary).lineSpacing(4)
                            if detail["research"]["status"].string == "needs_review" { Label("Some details need review", systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    if !visibleIdentities.isEmpty {
                        profileSection("Links", symbol: "link") {
                            ForEach(visibleIdentities, id: \.crmID) { item in
                                HStack(spacing: 12) {
                                    Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item["kind"].string.crmTitle).font(.caption).foregroundStyle(.secondary)
                                        linkedText(item["value"].string, kind: item["kind"].string)
                                    }
                                    Spacer(minLength: 0)
                                }.padding(.vertical, 4)
                            }
                            moreButton("identities")
                        }
                    }
                    if !(pages["facts"] ?? []).isEmpty {
                        profileSection("Background", symbol: "square.stack") {
                            ForEach(pages["facts"] ?? [], id: \.crmID) { item in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(item["predicate"].string.split(separator: ".").last.map(String.init)?.crmTitle ?? "Detail")
                                        .font(.subheadline.weight(.semibold))
                                    CRMFactValue(value: item["value"])
                                    provenance(item)
                                }.padding(.vertical, 6)
                                if item.crmID != pages["facts"]?.last?.crmID { Divider().padding(.vertical, 4) }
                            }
                            moreButton("facts")
                        }
                    }
                    if !(pages["relationships"] ?? []).isEmpty {
                        profileSection("Connections", symbol: "person.2") {
                            ForEach(pages["relationships"] ?? [], id: \.crmID) { item in
                                let side = item["from_id"].string == recordID ? "to" : "from"
                                let targetID = item["\(side)_id"].string
                                let name = item["\(side)_name"].string
                                NavigationLink { CRMProfileView(model: model, recordID: targetID) } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        CRMAvatar(name: name, size: 38)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(name.isEmpty ? "Related profile" : name).font(.body.weight(.semibold))
                                            if !item["role"].string.isEmpty || item["description"].string.isEmpty {
                                                Text(item["role"].string.isEmpty ? item["type"].string.crmTitle : item["role"].string)
                                                    .font(.caption).foregroundStyle(.secondary)
                                            }
                                            if !item["description"].string.isEmpty { Text(item["description"].string).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                                            provenance(item)
                                        }
                                        Spacer(minLength: 0)
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).padding(.top, 12)
                                    }.padding(.vertical, 6).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("crm-related-\(targetID)")
                            }
                            moreButton("relationships")
                        }
                    }
                    if !(pages["notes"] ?? []).isEmpty {
                        profileSection("Notes", symbol: "text.bubble") {
                            ForEach(pages["notes"] ?? [], id: \.crmID) { note in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(note["created_at"].crmDate).font(.caption).foregroundStyle(.tertiary)
                                    Text(note["body"].string).font(.subheadline).lineSpacing(3)
                                }.padding(.vertical, 5)
                            }
                            moreButton("notes")
                        }
                    }
                    if ["identities", "facts", "relationships", "notes"].allSatisfy({ (pages[$0] ?? []).isEmpty }) && detail["research"]["summary"].string.isEmpty {
                        CRMEmptyState(symbol: "text.bubble", title: "Their story starts here", detail: "Ask in chat to add a note, a link, or a little background.")
                    }
                }
                if loading { ProgressView().frame(maxWidth: .infinity).padding(24) }
                if let error { Text(error).foregroundStyle(.secondary); Button("Retry") { revision += 1 }.buttonStyle(.bordered) }
            }.padding(16).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .background(ChatPalette.background)
        .textSelection(.enabled)
        .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(ChatPalette.background, for: .navigationBar)
        .task(id: revision) { await load() }
        .refreshable { await load() }
    }

    private var visibleIdentities: [JSON] {
        let contacts = Set(["email", "phone", "website"].map { detail["record"][$0].string.lowercased() }.filter { !$0.isEmpty })
        return (pages["identities"] ?? []).filter { !contacts.contains($0["value"].string.lowercased()) }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                CRMAvatar(name: detail["record"]["name"].string, company: detail["record"]["kind"].string == "company", size: 44)
                VStack(alignment: .leading, spacing: 6) {
                    Text(detail["record"]["name"].string).font(.system(.title2, design: .rounded, weight: .bold))
                        .fixedSize(horizontal: false, vertical: true)
                    if !detail["record"]["title"].string.isEmpty { Text(detail["record"]["title"].string).font(.body).foregroundStyle(.secondary) }
                    if !detail["record"]["company_id"].string.isEmpty {
                        NavigationLink { CRMProfileView(model: model, recordID: detail["record"]["company_id"].string) } label: {
                            Label("View company", systemImage: "building.2").font(.subheadline)
                        }
                    }
                }
            }
            ForEach(["email", "phone", "website"], id: \.self) { key in
                let value = detail["record"][key].string
                if !value.isEmpty { linkedText(value, kind: key).font(.subheadline) }
            }
        }.padding(.vertical, 8)
    }
    private func sectionHeading(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
    }
    private func profileSection<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeading(title, symbol: symbol)
            VStack(alignment: .leading, spacing: 8, content: content)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 16))
        }
    }
    @ViewBuilder private func linkedText(_ value: String, kind: String) -> some View {
        if let url = Self.link(value, kind: kind) { Link(destination: url) { Text(value).lineLimit(2).truncationMode(.middle) } }
        else { Text(value) }
    }
    private static func link(_ value: String, kind: String) -> URL? {
        let candidate: String
        if kind == "email" { candidate = "mailto:\(value)" }
        else if kind == "phone" { candidate = "tel:\(value)" }
        else if value.hasPrefix("https://") || value.hasPrefix("http://") { candidate = value }
        else if kind == "x" { candidate = "https://x.com/\(value.trimmingCharacters(in: CharacterSet(charactersIn: "@")))" }
        else if kind == "github" { candidate = "https://github.com/\(value)" }
        else if kind == "linkedin" { candidate = "https://www.linkedin.com/in/\(value)" }
        else if kind == "telegram" { candidate = "https://t.me/\(value.trimmingCharacters(in: CharacterSet(charactersIn: "@")))" }
        else if ["website", "domain"].contains(kind), !value.contains(":") { candidate = "https://\(value)" }
        else { return nil }
        guard let url = URL(string: candidate), ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") else { return nil }
        return url
    }
    private func provenance(_ item: JSON) -> some View {
        Text([item["origin"].string == "user" ? "Your note" : item["origin"].string.crmTitle,
              item["confidence"].string.isEmpty ? "" : "\(item["confidence"].string) confidence",
              item["effective_from"].string, item["effective_to"].string].filter { !$0.isEmpty }.joined(separator: " · "))
            .font(.caption2).foregroundStyle(.tertiary)
    }
    @ViewBuilder private func moreButton(_ section: String) -> some View {
        if !(cursors[section] ?? "").isEmpty { Button("Load more \(section)") { Task { await load(section: section) } }.disabled(loading).font(.subheadline) }
    }
    @MainActor private func load(section: String? = nil) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let result: JSON
            if let section {
                if section == "notes" {
                    result = try await model.crmRead(id: recordID, query: ["notes_cursor": cursors[section] ?? ""])
                } else {
                    result = try await model.crmRead(id: recordID, section: section, query: ["cursor": cursors[section] ?? ""])
                }
                try Task.checkCancellation()
                pages[section, default: []] += result[section].array
                cursors[section] = result["next_cursor"].string
            } else {
                result = try await model.crmRead(id: recordID)
                try Task.checkCancellation()
                guard !result["record"].crmID.isEmpty else { throw APIError.invalidResponse }
                detail = result
                for key in ["notes", "identities", "facts", "relationships"] {
                    pages[key] = result[key].array
                    cursors[key] = result[key == "notes" ? "next_cursor" : "\(key)_next_cursor"].string
                }
            }
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

private struct CRMFactValue: View {
    let value: JSON
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if case .object(let fields) = value {
                ForEach(fields.keys.sorted(), id: \.self) { key in
                    if case .array(let entries) = fields[key] {
                        ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                            Text(entry.crmReadable).font(.subheadline).lineSpacing(3)
                                .padding(.leading, 12)
                                .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1).fill(Color.primary.opacity(0.12)).frame(width: 2) }
                        }
                    } else if fields[key] != .null {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(key.crmTitle).font(.caption).foregroundStyle(.secondary)
                            Text(fields[key]?.crmReadable ?? "").font(.subheadline)
                        }
                    }
                }
            } else { Text(value.crmReadable).font(.subheadline).lineSpacing(3) }
        }
    }
}

private extension String {
    var crmTitle: String { if self == "github" { return "GitHub" }; return replacingOccurrences(of: "_", with: " ").capitalized }
}
private extension JSON {
    var crmID: String { self["id"].string }
    var crmDate: String {
        if case .number(let milliseconds) = self { return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .omitted) }
        return string
    }
    var crmReadable: String {
        switch self {
        case .string(let value): return value
        case .null: return "—"
        case .object(let values): return values.keys.sorted().filter { values[$0] != .null }.map { "\($0.crmTitle): \(values[$0]!.crmReadable)" }.joined(separator: "\n")
        case .array(let values): return values.map(\.crmReadable).joined(separator: "\n\n")
        default: return pretty
        }
    }
}

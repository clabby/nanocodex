import SwiftUI
import UniformTypeIdentifiers
import InboxCore

struct ElevenLabsSettingsView: View {
    @Binding var settings: VoiceSettings
    let configuration: @MainActor () async throws -> VoiceConfiguration
    @State private var client: ElevenLabs?
    @State private var key = ""
    @State private var configured = false
    @State private var voices: [JSON] = []
    @State private var cursor: String?
    @State private var name = ""
    @State private var files: [URL] = []
    @State private var consent = false
    @State private var importing = false
    @State private var busy = false
    @State private var message: String?
    @State private var verification = false

    var body: some View {
        Section("ElevenLabs") {
            if configured {
                Text("API key connected and stored encrypted on the server.")
                Button("Disconnect ElevenLabs") { perform {
                    _ = try await client?.request(method: "DELETE")
                    configured = false; voices = []; settings.outputProvider = .openai; settings.elevenLabsVoiceId = nil
                } }
                Picker("ElevenLabs voice", selection: $settings.elevenLabsVoiceId) {
                    Text("Select a voice").tag(Optional<String>.none)
                    ForEach(voices.indices, id: \.self) { index in
                        Text(voices[index]["name"].string).tag(Optional(voices[index]["voice_id"].string))
                    }
                }
                Button("Refresh voices") { perform { try await loadVoices() } }
                if cursor != nil { Button("Load more voices") { perform { try await loadVoices(more: true) } } }
                TextField("Clone name", text: $name)
                Button(files.isEmpty ? "Choose audio samples" : "\(files.count) samples selected") { importing = true }
                Text("One to five samples, up to 10 MB each and below 20 MB total.").font(.caption)
                Toggle("I own this voice or have explicit permission to clone and use it.", isOn: $consent)
                Button("Create voice clone") { perform {
                    guard let client else { return }
                    let result = try await client.clone(name: name, files: files, consent: consent)
                    verification = result["requires_verification"].bool
                    if verification {
                        message = "Voice created. Complete verification in ElevenLabs before selecting it, then refresh voices."
                    } else {
                        settings.elevenLabsVoiceId = result["voice_id"].string
                        message = "Voice created and selected."
                    }
                    files = []; consent = false
                    try await loadVoices()
                } }.disabled(!consent || files.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if verification { Link("Open ElevenLabs verification", destination: URL(string: "https://elevenlabs.io/app/voice-lab")!) }
            } else {
                SecureField("ElevenLabs API key", text: $key)
                Button("Connect ElevenLabs") { perform {
                    guard let client else { return }
                    _ = try await client.request(method: "PUT", body: .object(["api_key": .string(key)]))
                    key = ""; configured = true
                    try await loadVoices()
                } }.disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if busy { ProgressView() }
            if let message { Text(message).font(.caption).textSelection(.enabled) }
        }
        .disabled(busy)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): files = urls
            case .failure(let error): message = error.localizedDescription
            }
        }
        .task {
            busy = true
            defer { busy = false }
            do {
                client = try await ElevenLabs(configuration: configuration())
                configured = try await client?.request()["configured"].bool ?? false
                if configured { try await loadVoices() }
            } catch { message = error.localizedDescription }
        }
    }
    @MainActor private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; message = nil
        Task {
            defer { busy = false }
            do { try await action() } catch { message = error.localizedDescription }
        }
    }
    @MainActor private func loadVoices(more: Bool = false) async throws {
        guard let client else { return }
        var suffix = "/voices"
        if more, let cursor {
            var parts = URLComponents(); parts.queryItems = [URLQueryItem(name: "next_page_token", value: cursor)]
            suffix += "?" + (parts.percentEncodedQuery ?? "")
        }
        let result = try await client.request(suffix)
        let fetched = result["voices"].array
        voices = more ? voices + fetched.filter { item in !voices.contains(where: { $0["voice_id"] == item["voice_id"] }) } : fetched
        cursor = result["has_more"].bool && !result["next_page_token"].string.isEmpty ? result["next_page_token"].string : nil
    }
}

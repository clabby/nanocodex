import SwiftUI
import UniformTypeIdentifiers
import InboxCore

struct ElevenLabsSettingsView: View {
    @ObservedObject var session: VoiceSession
    @Binding var sampleAudioBusy: Bool
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

    @State private var catalog: VoiceCatalog = .all
    #if os(iOS)
    @StateObject private var recording = VoiceCloneRecording()
    @Environment(\.scenePhase) private var scenePhase
    #endif
    private var displayedVoices: [JSON] { voices.filter { catalog.includes($0) } }
    private var cloneFiles: [URL] {
        #if os(iOS)
        if let sample = recording.sample { return [sample] }
        #endif
        return files
    }

    var body: some View {
        Section("ElevenLabs") {
            if configured {
                Text("API key connected and stored encrypted on the server.")
                Button("Disconnect ElevenLabs") { perform {
                    _ = try await client?.request(method: "DELETE")
                    configured = false; voices = []; settings.outputProvider = .openai; settings.elevenLabsVoiceId = nil
                } }.disabled(sampleAudioBusy)
                Picker("Voice catalog", selection: $catalog) {
                    ForEach(VoiceCatalog.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
                ForEach(displayedVoices.indices, id: \.self) { index in
                    let voice = displayedVoices[index]
                    Button {
                        settings.elevenLabsVoiceId = voice["voice_id"].string
                    } label: {
                        HStack {
                            Text(voice["name"].string)
                            Spacer()
                            if settings.elevenLabsVoiceId == voice["voice_id"].string { Image(systemName: "checkmark") }
                        }
                    }.accessibilityAddTraits(settings.elevenLabsVoiceId == voice["voice_id"].string ? .isSelected : [])
                }
                if displayedVoices.isEmpty { Text("No voices in this loaded catalog. Refresh or load more voices.").font(.caption) }
                if let selected = settings.elevenLabsVoiceId {
                    Text("Selected: " + (voices.first { $0["voice_id"].string == selected }?["name"].string ?? selected)).font(.caption)
                }
                Text(session.isEngaged ? "Apply and reconnect to use the selected voice." : "Save to use the selected voice on your next call.").font(.caption)
                Button("Refresh voices") { perform { try await loadVoices() } }.disabled(sampleAudioBusy)
                if cursor != nil { Button("Load more voices") { perform { try await loadVoices(more: true) } }.disabled(sampleAudioBusy) }
                TextField("Clone name", text: $name)
                #if os(iOS)
                recordingControls
                #endif
                Button(files.isEmpty ? "Choose audio samples" : "\(files.count) samples selected") {
                    #if os(iOS)
                    recording.discard()
                    #endif
                    consent = false; importing = true
                }
                Text("One to five samples, up to 10 MB each and below 20 MB total.").font(.caption)
                Toggle("I own this voice or have explicit permission to clone and use it.", isOn: $consent)
                Button("Create voice clone") { perform {
                    guard let client else { return }
                    let result = try await client.clone(name: name, files: cloneFiles, consent: consent)
                    verification = result["requires_verification"].bool
                    if verification {
                        message = "Voice created. Complete verification in ElevenLabs before selecting it, then refresh voices."
                    } else {
                        settings.elevenLabsVoiceId = result["voice_id"].string
                        message = "Voice created and selected."
                    }
                    #if os(iOS)
                    recording.discard()
                    #endif
                    files = []; consent = false
                    try await loadVoices()
                    if !verification, let id = settings.elevenLabsVoiceId,
                       !voices.contains(where: { $0["voice_id"].string == id }) {
                        voices.insert(.object(["voice_id": .string(id), "name": .string(name), "category": .string("cloned")]), at: 0)
                    }
                    if !verification { catalog = .cloned }
                } }.disabled(sampleAudioBusy || !consent || cloneFiles.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
        #if os(iOS)
        .onDisappear { recording.discard(); sampleAudioBusy = false; key = "" }
        .onChange(of: recording.recording) { _, _ in updateAudioBusy() }
        .onChange(of: recording.playing) { _, _ in updateAudioBusy() }
        .onChange(of: recording.preparing) { _, _ in updateAudioBusy() }
        .onChange(of: busy) { _, _ in updateAudioBusy() }
        .onChange(of: session.isEngaged) { _, engaged in if engaged { recording.discard(); updateAudioBusy() } }
        .onChange(of: scenePhase) { _, phase in
            // A microphone permission sheet temporarily makes the scene inactive.
            if phase == .background || (phase == .inactive && !recording.preparing) { recording.suspend() }
        }
        #endif
        .disabled(busy)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): files = urls; consent = false
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
    #if os(iOS)
    private func updateAudioBusy() {
        sampleAudioBusy = busy || recording.preparing || recording.recording || recording.playing
    }
    @ViewBuilder private var recordingControls: some View {
        if session.isEngaged {
            Button("End voice call to record a sample") { session.stop() }
            Text("Recording and review use the microphone and speaker after your call ends.").font(.caption)
        } else if recording.preparing {
            Text("Waiting for microphone permission…")
            Button("Cancel recording") { recording.discard() }
        } else if recording.recording {
            Label("Recording \(Int(recording.elapsed)) / 120 seconds", systemImage: "record.circle.fill")
                .foregroundStyle(.red)
            ProgressView(value: Double(recording.level)).accessibilityLabel("Microphone level")
            Text("Aim for 60–90 seconds. Speak naturally in your usual tone in a quiet room; avoid music and other voices.").font(.caption)
            Button("Stop recording") { recording.stop() }
        } else {
            Text("Record 60–90 seconds in a quiet room using your usual tone. Recording stops after two minutes.").font(.caption)
            Button(recording.sample == nil ? "Record voice sample" : "Record again") {
                files = []; consent = false
                sampleAudioBusy = true
                Task { await recording.start(); updateAudioBusy() }
            }
            if recording.sample != nil {
                Button(recording.playing ? "Stop playback" : "Review recording") {
                    if recording.playing { recording.stopPlayback() } else { recording.play() }
                }
                Button("Remove recording", role: .destructive) { recording.discard(); consent = false }
                Text("Recorded \(Int(recording.duration.rounded())) seconds.").font(.caption)
                if recording.duration < 30 { Text("This sample is short. Aim for 60–90 seconds for a more representative voice clone.").font(.caption) }
                Text("Review your recording before consenting to upload it. Audio stays on this device until you create the clone.").font(.caption)
            }
        }
        if let error = recording.error { Text(error).font(.caption).foregroundStyle(.red) }
    }
    #endif
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

/// ElevenLabs returns instant clones as cloned and verified professional clones as professional.
enum VoiceCatalog: String, CaseIterable {
    case all = "All", existing = "Existing", cloned = "Cloned"
    func includes(_ voice: JSON) -> Bool {
        let clone = ["cloned", "professional"].contains(voice["category"].string)
        return self == .all || (self == .cloned ? clone : !clone)
    }
}

import ActivityKit
import AVFoundation
import Combine
import InboxCore
import OSLog
import UIKit

/// App-process owner for a recording launched by a Control Widget while the phone
/// is locked. The scene and the intent can both disappear without ending capture.
@MainActor
final class MeetingLockedCoordinator {
    static let shared = MeetingLockedCoordinator()

    enum CaptureError: LocalizedError {
        case busy, permissions, account, unavailable, stale, notReady
        var errorDescription: String? {
            switch self {
            case .busy: "Finish the current recording first."
            case .permissions: "Open Nanocodex once to grant Microphone access."
            case .account: "Sign in to Nanocodex before recording from the Lock Screen."
            case .unavailable: "The microphone or Live Activity is unavailable."
            case .stale: "That recording is no longer available."
            case .notReady: "Stop recording and wait for transcription before saving."
            }
        }
    }

    private struct ReadySnapshot: Codable {
        let id: String
        let account: String
        let transcript: String
        let warning: Bool
        let ready: Bool
    }
    private static let scopePointerKey = "inbox.lockedMeeting.activeScope"
    private static func snapshotKey(_ scope: String) -> String { "inbox.lockedMeeting.ready." + scope }

    @MainActor private final class Capture {
        let id = UUID().uuidString
        let account: String
        let recorder = MeetingRecorder.shared
        var activity: Activity<MeetingLockedActivityAttributes>?
        var observers: [AnyCancellable] = []
        var ticker: Task<Void, Never>?
        var previewTask: Task<Void, Never>?
        var previewNextIndex = 0
        var previewPieceOffset = 0
        var previewRevision = 0
        var previewRetryAt = Date.distantPast
        var recap: String?
        var pendingUpdate: Task<Void, Never>?
        var background: UIBackgroundTaskIdentifier = .invalid
        var phase = "preparing"
        var stopping = false
        var lastCheckpoint = Date.distantPast
        var ownsRecorder: Bool { recorder.captureID == UUID(uuidString: id) }
        init(account: String) { self.account = account }
    }
    private var capture: Capture?
    private let model = InboxModel.shared
    private let log = Logger(subsystem: "xyz.paradigm.centaur", category: "MeetingLocked")

    func start() async throws {
        // A killed app may leave a partial checkpoint but no active microphone.
        // Preserve it as an account-scoped draft and allow a fresh locked capture.
        if savedSnapshot?.ready == false { recoverOutstanding() }
        if let stale = capture, !stale.ownsRecorder { finishCapture(stale, phase: "saved") }
        guard QuickVoiceRecorder.audioOwner == nil,
              !model.voice.isEngaged, !MeetingRecorder.shared.working else { throw CaptureError.busy }
        guard AVAudioApplication.shared.recordPermission == .granted else { throw CaptureError.permissions }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw CaptureError.unavailable }
        let account: String
        do { account = try model.lockedVoiceAccountScope() }
        catch { throw CaptureError.account }
        // A completed transcript must not monopolize the recorder when delivery
        // failed. Move it to its original account's recovery journal (or leave its
        // existing pending turn in charge) before starting another capture. This
        // is preservation, not a user-facing discard or an automatic retry.
        if let snapshot = savedSnapshot, snapshot.ready {
            try importSnapshot(snapshot)
            if let current = capture, current.id == snapshot.id {
                finishCapture(current, phase: "saved")
            }
            clearSnapshot(id: snapshot.id)
        }
        guard capture == nil, savedSnapshot == nil else { throw CaptureError.busy }
        // An OS termination may have left a stale recording activity with no
        // owning audio process. Do not display a second apparently live mic.
        for orphan in Activity<MeetingLockedActivityAttributes>.activities {
            await orphan.end(content(phase: "failed", seconds: 0), dismissalPolicy: .immediate)
        }
        let current = Capture(account: account)
        capture = current
        do {
            current.activity = try Activity.request(
                attributes: MeetingLockedActivityAttributes(captureID: current.id),
                content: content(phase: "preparing", seconds: 0), pushType: nil)
        } catch {
            capture = nil
            throw CaptureError.unavailable
        }
        let id = current.id
        current.observers.append(current.recorder.$reviewing.dropFirst().sink { [weak self] ready in
            guard ready else { return }
            Task { @MainActor in self?.becameReady(id: id) }
        })
        current.observers.append(current.recorder.$transcriptionWarning.dropFirst().sink { [weak self] _ in
            Task { @MainActor in
                guard let self, let active = self.capture, active.id == id, active.ownsRecorder, active.recorder.recording else { return }
                self.update(active, phase: "listening")
            }
        })
        current.observers.append(current.recorder.$transcript.dropFirst().sink { [weak self] text in
            Task { @MainActor in self?.checkpoint(id: id, text: text) }
        })
        current.observers.append(current.recorder.$finalizedSegments.dropFirst().sink { [weak self] _ in
            Task { @MainActor in self?.streamFinalizedText(id: id) }
        })
        current.observers.append(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification).sink { [weak self] notification in
            guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  type == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.interrupt(id: id) }
        })
        current.observers.append(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification).sink { [weak self] notification in
            guard let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            Task { @MainActor in self?.interrupt(id: id) }
        })
        let locale = UserDefaults.standard.string(forKey: "quickVoice.locale") == "el-GR" ? "el-GR" : "en-US"
        await current.recorder.start(locale: locale, permissionsGranted: true, accountScope: account, captureID: UUID(uuidString: current.id))
        guard capture === current, current.ownsRecorder, current.recorder.recording else {
            // A failed startup cannot leave an apparently active Lock Screen control.
            finishCapture(current, phase: "failed")
            throw CaptureError.unavailable
        }
        update(current, phase: "listening")
        VoiceDiagnostic.note("meeting.coordinator.recording")
        current.ticker = Task { [weak self, weak current] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                guard let self, let current, self.capture === current, current.ownsRecorder else { return }
                if current.recorder.recording {
                    self.update(current, phase: "listening")
                    self.streamFinalizedText(id: current.id)
                }
                else if current.recorder.reviewing { self.becameReady(id: current.id); return }
                else if !current.stopping {
                    self.beginFinishing(current)
                    current.recorder.interrupt("Recording stopped. Review the partial transcript before saving.")
                    return
                }
            }
        }
    }

    func finishAndSave(captureID: String) async throws {
        try await stop(captureID: captureID)
        try await save(captureID: captureID)
    }

    private func stop(captureID: String) async throws {
        guard let current = capture, current.id == captureID, current.ownsRecorder else {
            if let snapshot = savedSnapshot, snapshot.id == captureID, snapshot.ready { return }
            if let id = UUID(uuidString: captureID), let scope = try? model.lockedVoiceAccountScope(),
               let entry = try model.meetingRecordingStore?.entries(scope: scope).first(where: { $0.id == id }), entry.state != .capturing { return }
            throw CaptureError.stale
        }
        if current.recorder.working {
            beginFinishing(current)
            current.recorder.finish()
            update(current, phase: "transcribing")
        }
        // Keep this AudioRecordingIntent alive for the bounded final Speech results.
        for _ in 0..<120 {
            guard capture === current, current.ownsRecorder else {
                // The review observer may already have retired this wrapper
                // after committing its document. Never touch a newer recorder.
                if hasSavedMeeting(id: captureID, account: current.account) { return }
                throw CaptureError.stale
            }
            if current.recorder.reviewing { becameReady(id: captureID); return }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard capture === current, current.ownsRecorder else {
            if hasSavedMeeting(id: captureID, account: current.account) { return }
            throw CaptureError.stale
        }
        current.recorder.interrupt("Transcription timed out. Review the partial transcript before saving.")
        throw CaptureError.notReady
    }

    private func hasSavedMeeting(id: String, account: String) -> Bool {
        guard let id = UUID(uuidString: id),
              let entry = try? model.meetingRecordingStore?.entries(scope: account).first(where: { $0.id == id }) else { return false }
        return [.pending, .synced, .conflicted].contains(entry.state)
    }

    func save(captureID: String) async throws {
        guard let id = UUID(uuidString: captureID) else { throw CaptureError.stale }
        let scope = try model.lockedVoiceAccountScope()
        if let stale = capture, stale.id == captureID, !stale.ownsRecorder { finishCapture(stale, phase: "saved") }
        if let current = capture, current.id == captureID, current.ownsRecorder {
            guard current.account == scope else { throw CaptureError.account }
            guard current.recorder.reviewing, !current.recorder.working else { throw CaptureError.notReady }
            guard current.recorder.saveDraft() else { throw CocoaError(.fileWriteUnknown) }
        }
        if let snapshot = savedSnapshot, snapshot.id == captureID {
            guard snapshot.account == scope else { throw CaptureError.account }
            try importSnapshot(snapshot)
            clearSnapshot(id: captureID)
        }
        guard let store = model.meetingRecordingStore,
              try store.entries(scope: scope).contains(where: { $0.id == id }) else { throw CaptureError.stale }
        // Durable local save is success even offline. Sync remains in the journal
        // with the same UUID/revision; retry never creates an agent conversation.
        await model.syncMeetingRecording(accountScope: scope)
        if let current = capture, current.id == captureID { finishCapture(current, phase: "saved") }
        else { await activity(for: captureID)?.end(content(phase: "saved", seconds: 0), dismissalPolicy: .after(Date().addingTimeInterval(15))) }
    }

    private func importSnapshot(_ snapshot: ReadySnapshot) throws {
        guard let id = UUID(uuidString: snapshot.id), let store = model.meetingRecordingStore else { throw CaptureError.stale }
        // SQLite has the complete title/notes/duration. A legacy defaults snapshot
        // must not overwrite it, including an acknowledged deletion tombstone.
        if try store.entries(scope: snapshot.account, includeDeleted: true).contains(where: { $0.id == id }) { return }
        let record = MeetingRecord(id: id, title: "Recovered meeting", transcript: snapshot.transcript, partial: snapshot.warning || !snapshot.ready)
        try store.put(record, scope: snapshot.account, state: .pending)
    }

    /// The scene's foreground entry hands an orphaned or failed Lock Screen
    /// capture to the ordinary account-scoped recovery draft. Never display it
    /// to a different account; the Live Activity itself contains no text.
    func recoverOutstanding() {
        guard let snapshot = savedSnapshot, capture?.id != snapshot.id,
              (try? model.lockedVoiceAccountScope()) == snapshot.account else { return }
        do { try importSnapshot(snapshot) }
        catch { return } // Never clear the last recoverable copy after disk failure.
        model.meetingLibrary?.reloadLocal()
        Task { await model.syncMeetingRecording(accountScope: snapshot.account) }
        clearSnapshot(id: snapshot.id)
        Task { await activity(for: snapshot.id)?.end(content(phase: "failed", seconds: 0, warning: true),
                                                     dismissalPolicy: .immediate) }
    }

    private func checkpoint(id: String, text: String) {
        guard let current = capture, current.id == id, current.ownsRecorder,
              Date().timeIntervalSince(current.lastCheckpoint) >= 5 else { return }
        current.lastCheckpoint = Date()
        _ = current.recorder.checkpoint(force: false)
    }

    /// Speech partials revise in place and never enter the preview endpoint. Only
    /// segments settled in capture order are streamed. Retries reuse the same
    /// revision and text; a failed preview never gates Stop or durable document saving.
    private func streamFinalizedText(id: String) {
        guard let current = capture, current.id == id, current.ownsRecorder, current.previewTask == nil,
              Date() >= current.previewRetryAt, let captureID = UUID(uuidString: id) else { return }
        let settled = Set(current.recorder.settledSegmentIndices)
        let finals = Dictionary(uniqueKeysWithValues: current.recorder.finalizedSegments.map { ($0.index, $0.text) })
        var index = current.previewNextIndex
        while settled.contains(index), finals[index]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false { index += 1 }
        current.previewNextIndex = index
        guard let delta = finals[index], !delta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        VoiceDiagnostic.note("meeting.preview.segmentReady")
        // Recognition segments are normally far below this limit. If a very long
        // result exceeds it, send bounded UTF-8 chunks under consecutive revisions.
        let pieces = boundedPreviewChunks(delta)
        guard !pieces.isEmpty else { return }
        let expectedScope = current.account
        let firstUnsent = current.previewPieceOffset
        guard firstUnsent < pieces.count else { return }
        current.previewTask = Task { [weak self, weak current] in
            guard let self, let current else { return }
            for piece in pieces.dropFirst(firstUnsent) {
                guard self.capture === current, current.ownsRecorder, !Task.isCancelled else { return }
                let revision = current.previewRevision + 1
                do {
                    let result = try await self.model.updateMeetingPreview(captureID: captureID,
                        revision: revision, delta: piece, accountScope: expectedScope)
                    guard self.capture === current, current.ownsRecorder, !Task.isCancelled else { return }
                    current.previewRevision = revision
                    current.previewRetryAt = .distantPast
                    current.previewPieceOffset += 1
                    VoiceDiagnostic.note(result.summaryRevision > 0 && !result.summary.isEmpty
                        ? "meeting.preview.summaryReceived" : "meeting.preview.pending")
                    if !result.summary.isEmpty, result.summaryRevision > 0 {
                        current.recap = String(result.summary.prefix(180))
                        self.update(current, phase: current.phase)
                    }
                } catch {
                    VoiceDiagnostic.note("meeting.preview.failed", error: error)
                    // Ambiguous admission: repeat this exact revision after a
                    // bounded delay. Never advance the cursor on uncertain write.
                    current.previewRetryAt = Date().addingTimeInterval(30)
                    break
                }
            }
            if current.previewPieceOffset == pieces.count {
                current.previewNextIndex = index + 1
                current.previewPieceOffset = 0
            }
            current.previewTask = nil
            if current.previewNextIndex > index { self.streamFinalizedText(id: id) }
        }
    }

    private func boundedPreviewChunks(_ text: String) -> [String] {
        var chunks: [String] = [], current = "", size = 0
        for character in text {
            let bytes = String(character).utf8.count
            if size + bytes > 4096, !current.isEmpty {
                chunks.append(current); current = ""; size = 0
            }
            current.append(character); size += bytes
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    private var savedSnapshot: ReadySnapshot? {
        guard let scope = UserDefaults.standard.string(forKey: Self.scopePointerKey),
              let data = UserDefaults.standard.data(forKey: Self.snapshotKey(scope)),
              let snapshot = try? JSONDecoder().decode(ReadySnapshot.self, from: data),
              snapshot.account == scope else { return nil }
        return snapshot
    }

    private func clearSnapshot(id: String) {
        guard let snapshot = savedSnapshot, snapshot.id == id else { return }
        UserDefaults.standard.removeObject(forKey: Self.snapshotKey(snapshot.account))
        UserDefaults.standard.removeObject(forKey: Self.scopePointerKey)
    }

    private func activity(for id: String) -> Activity<MeetingLockedActivityAttributes>? {
        if capture?.id == id { return capture?.activity }
        return Activity<MeetingLockedActivityAttributes>.activities.first { $0.attributes.captureID == id }
    }

    private func interrupt(id: String) {
        guard let current = capture, current.id == id, current.ownsRecorder, current.recorder.recording else { return }
        beginFinishing(current)
        current.recorder.interrupt()
        update(current, phase: "transcribing", warning: true)
    }

    private func beginFinishing(_ current: Capture) {
        guard !current.stopping else { return }
        current.stopping = true
        current.background = UIApplication.shared.beginBackgroundTask(withName: "Finish meeting transcription") { [weak self, weak current] in
            Task { @MainActor in
                guard let self, let current, self.capture === current, current.ownsRecorder else { return }
                self.becameReady(id: current.id, force: true)
            }
        }
    }

    private func becameReady(id: String, force: Bool = false) {
        guard let current = capture, current.id == id, current.ownsRecorder,
              current.recorder.reviewing || force else { return }
        current.ticker?.cancel(); current.ticker = nil
        if force, current.recorder.working {
            current.recorder.interrupt("Recording interrupted. Partial meeting retained.")
            _ = current.recorder.checkpoint()
            update(current, phase: "transcribing", warning: true)
        } else if current.recorder.saveDraft() {
            // Once the document is journaled, the locked wrapper no longer owns
            // review or foreground reset. Offline sync remains a library concern.
            let scope = current.account
            let meetingID = current.recorder.captureID
            finishCapture(current, phase: "saved")
            // Optional enhancement is independent of the successful durable save.
            // Bounded transport/backend generation may fail; the document stays.
            Task { [weak self] in
                guard let self else { return }
                await self.model.syncMeetingRecording(accountScope: scope)
                guard let library = self.model.meetingLibrary, library.scope == scope else { return }
                try? await library.summarize(id: meetingID)
            }
        } else {
            update(current, phase: "ready", warning: true)
        }
        releaseBackground(current)
    }

    private func releaseBackground(_ current: Capture) {
        if current.background != .invalid {
            UIApplication.shared.endBackgroundTask(current.background)
            current.background = .invalid
        }
    }

    private func content(phase: String, seconds: Int, warning: Bool = false) -> ActivityContent<MeetingLockedActivityAttributes.ContentState> {
        ActivityContent(state: .init(phase: phase, seconds: seconds, warning: warning),
                        staleDate: ["preparing", "listening", "transcribing"].contains(phase) ? Date().addingTimeInterval(90) : nil)
    }

    private func update(_ current: Capture, phase: String, warning: Bool = false) {
        guard capture === current, current.ownsRecorder else { return }
        current.phase = phase
        let previous = current.pendingUpdate
        let next = ActivityContent<MeetingLockedActivityAttributes.ContentState>(
            state: .init(phase: phase, seconds: current.recorder.seconds, warning: warning || current.recorder.completedWithWarning,
                         recap: phase == "listening" ? current.recap : nil),
            staleDate: ["preparing", "listening", "transcribing"].contains(phase)
                ? Date().addingTimeInterval(90) : nil)
        current.pendingUpdate = Task { [weak current] in
            await previous?.value
            await current?.activity?.update(next)
        }
    }

    private func finishCapture(_ current: Capture, phase: String) {
        guard capture === current else { return }
        capture = nil // Fence all recognizer callbacks before tearing down audio.
        current.ticker?.cancel()
        current.previewTask?.cancel()
        current.observers.removeAll()
        let elapsed = current.ownsRecorder ? current.recorder.seconds : 0
        if phase == "saved", let captureID = UUID(uuidString: current.id) {
            Task { await model.closeMeetingPreview(captureID: captureID, accountScope: current.account) }
        }
        // Sheet/Live Activity teardown does not discard shared recorder state.
        // A failed startup is still checkpointed as a partial meeting.
        if current.ownsRecorder { _ = current.recorder.checkpoint() }
        let previous = current.pendingUpdate
        let activity = current.activity
        let final = content(phase: phase, seconds: elapsed,
                            warning: current.ownsRecorder && current.recorder.completedWithWarning)
        Task { await previous?.value; await activity?.end(final, dismissalPolicy: .after(Date().addingTimeInterval(15))) }
        releaseBackground(current)
        VoiceDiagnostic.note("meeting.coordinator.ended.\(phase)")
        log.info("Meeting capture ended: \(phase, privacy: .public)")
    }
}

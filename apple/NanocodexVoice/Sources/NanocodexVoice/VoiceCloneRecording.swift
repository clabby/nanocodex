#if os(iOS)
import AVFoundation
import SwiftUI

/// Owns only locally recorded samples. Imported security-scoped files remain owned by Files.
@MainActor final class VoiceCloneRecording: NSObject, ObservableObject, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
    @Published private(set) var preparing = false
    @Published private(set) var recording = false
    @Published private(set) var saving = false
    @Published private(set) var permissionDenied = false
    @Published private(set) var playing = false
    @Published private(set) var playingURL: URL?
    @Published private(set) var sample: URL?
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var playbackElapsed: TimeInterval = 0
    @Published private(set) var playbackDuration: TimeInterval = 0
    @Published private(set) var level: Float = 0
    @Published var error: String?
    private var meterTask: Task<Void, Never>?
    private var playbackTask: Task<Void, Never>?
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var pendingURL: URL?
    private var playbackAccess: PlaybackAccess?

    /// Balances imported-file access even when this controller is released during playback.
    private final class PlaybackAccess {
        let url: URL
        let scoped: Bool
        init(url: URL) {
            self.url = url
            scoped = url.startAccessingSecurityScopedResource()
        }
        deinit {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
    }
    private var generation = UUID()
    private var ownsAudio = false

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(audioInterrupted), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(audioRouteChanged), name: AVAudioSession.routeChangeNotification, object: nil)
    }
    deinit {
        meterTask?.cancel()
        playbackTask?.cancel()
        NotificationCenter.default.removeObserver(self)
    }
    @objc nonisolated private func audioRouteChanged(_ notification: Notification) {
        guard let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
        Task { @MainActor [weak self] in self?.suspend() }
    }
    @objc nonisolated private func audioInterrupted(_ notification: Notification) {
        guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              type == AVAudioSession.InterruptionType.began.rawValue else { return }
        Task { @MainActor [weak self] in self?.suspend() }
    }

    func start() async {
        guard !preparing, !recording, !saving else { return }
        stopPlayback()
        generation = UUID()
        elapsed = 0
        error = nil
        let token = generation
        preparing = true
        permissionDenied = false
        let granted = await AVAudioApplication.requestRecordPermission()
        guard token == generation else { return }
        preparing = false
        permissionDenied = !granted
        guard granted else { error = "Allow microphone access in Settings to record a voice sample."; return }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try audio.setActive(true)
            ownsAudio = true
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-clone-\(UUID().uuidString).m4a")
            pendingURL = url
            let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128000])
            recorder.isMeteringEnabled = true
            recorder.delegate = self
            self.recorder = recorder
            guard recorder.record(forDuration: 120) else { throw CocoaError(.fileWriteUnknown) }
            recording = true
            meterTask = Task { [weak self] in
                while !Task.isCancelled {
                    self?.updateMeter()
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                }
            }
        } catch { abandonPendingRecording(); self.error = "Could not start recording. Check microphone access and try again." }
    }
    #if DEBUG
    /// Seeds capture ownership without requesting microphone permission or starting audio I/O.
    func prepareRecordingForTesting(_ recorder: AVAudioRecorder) {
        abandonPendingRecording()
        stopPlayback()
        pendingURL = recorder.url
        self.recorder = recorder
        recording = true
    }
    #endif
    private func updateMeter() {
        guard let recorder, recording else { return }
        elapsed = recorder.currentTime
        recorder.updateMeters()
        level = min(1, max(0, pow(10, recorder.averagePower(forChannel: 0) / 20)))
    }
    func stop() {
        guard recording, let recorder else { return }
        updateMeter()
        recording = false
        saving = true
        meterTask?.cancel(); meterTask = nil; level = 0
        recorder.stop()
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            self.meterTask?.cancel(); self.meterTask = nil; self.level = 0
            self.recording = false; self.saving = false; self.recorder = nil
            if flag, let replacement = self.pendingURL {
                let previous = self.sample
                self.sample = replacement; self.pendingURL = nil
                self.duration = (try? AVAudioPlayer(contentsOf: replacement).duration) ?? self.elapsed
                if let previous, previous != replacement { try? FileManager.default.removeItem(at: previous) }
            }
            else { self.abandonPendingRecording(); self.error = "Recording was interrupted. Please record again." }
            self.releaseAudio()
        }
    }
    func play() {
        guard let sample else { return }
        play(url: sample)
    }
    func play(url: URL) {
        guard !preparing, !recording, !saving else { return }
        stopPlayback()
        error = nil
        playbackElapsed = 0
        playbackAccess = PlaybackAccess(url: url)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            ownsAudio = true
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self; self.player = player
            playbackDuration = player.duration
            guard player.play() else { throw CocoaError(.fileReadCorruptFile) }
            playingURL = url
            playing = true
            playbackTask = Task { [weak self] in
                while !Task.isCancelled {
                    self?.updatePlaybackProgress()
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                }
            }
        } catch { stopPlayback(); self.error = "Could not play this sample. Please record again." }
    }
    private func updatePlaybackProgress() {
        guard playing, let player else { return }
        playbackElapsed = player.currentTime
    }
    func stopPlayback() {
        playbackTask?.cancel(); playbackTask = nil
        let old = player
        player = nil
        old?.stop()
        playbackAccess = nil
        playingURL = nil
        playing = false
        playbackElapsed = 0
        playbackDuration = 0
        if recorder == nil { releaseAudio() }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in guard self.player === player else { return }; self.stopPlayback() }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            guard self.player === player else { return }
            self.stopPlayback(); self.error = "Could not play this sample. Please record again."
        }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            self.abandonPendingRecording(); self.error = "Recording failed. Please record again."
        }
    }
    /// Cancels a permission request without removing the sample already under review.
    func cancelPreparation() {
        guard preparing else { return }
        generation = UUID()
        preparing = false
    }
    private func abandonPendingRecording() {
        generation = UUID()
        meterTask?.cancel(); meterTask = nil
        preparing = false; recording = false; saving = false
        elapsed = 0; level = 0
        let old = recorder
        recorder = nil
        old?.stop()
        if let pendingURL { try? FileManager.default.removeItem(at: pendingURL) }
        pendingURL = nil
        releaseAudio()
    }
    func discard() {
        abandonPendingRecording()
        stopPlayback()
        if let sample { try? FileManager.default.removeItem(at: sample) }
        sample = nil; duration = 0; error = nil
    }
    func suspend() {
        cancelPreparation()
        if recording { stop() }
        if playing { stopPlayback() }
    }
    private func releaseAudio() { guard ownsAudio else { return }; ownsAudio = false; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
}
#endif

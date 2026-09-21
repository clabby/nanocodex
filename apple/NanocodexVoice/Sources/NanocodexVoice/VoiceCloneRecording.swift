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
    @Published private(set) var sample: URL?
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var playbackElapsed: TimeInterval = 0
    @Published private(set) var level: Float = 0
    @Published var error: String?
    private var meterTask: Task<Void, Never>?
    private var playbackTask: Task<Void, Never>?
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var pendingURL: URL?
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
        discard()
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
        } catch { discard(); self.error = "Could not start recording. Check microphone access and try again." }
    }
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
            if flag {
                self.sample = self.pendingURL; self.pendingURL = nil
                if let sample = self.sample { self.duration = (try? AVAudioPlayer(contentsOf: sample).duration) ?? self.elapsed }
            }
            else { self.discard(); self.error = "Recording was interrupted. Please record again." }
            self.releaseAudio()
        }
    }
    func play() {
        guard !preparing, !recording, !saving, !playing, let sample else { return }
        playbackElapsed = 0
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            ownsAudio = true
            let player = try AVAudioPlayer(contentsOf: sample)
            player.delegate = self; self.player = player
            guard player.play() else { throw CocoaError(.fileReadCorruptFile) }
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
        playing = false
        playbackElapsed = 0
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
            self.discard(); self.error = "Recording failed. Please record again."
        }
    }
    func discard() {
        generation = UUID()
        meterTask?.cancel(); meterTask = nil
        elapsed = 0; duration = 0; level = 0
        preparing = false; saving = false
        let old = recorder; recorder = nil; old?.stop(); recording = false
        stopPlayback()
        for url in [sample, pendingURL].compactMap({ $0 }) { try? FileManager.default.removeItem(at: url) }
        sample = nil; pendingURL = nil; error = nil
    }
    func suspend() {
        generation = UUID()
        preparing = false
        if recording { stop() }
        if playing { stopPlayback() }
    }
    private func releaseAudio() { guard ownsAudio else { return }; ownsAudio = false; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
}
#endif

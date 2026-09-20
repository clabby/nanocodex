//! Bounded external PCM source for the same libWebRTC mixer/ADM/APM as remote audio.
use codex_realtime_webrtc::{MAX_PCM_SAMPLES, PcmStatus};
use libwebrtc::native::audio_resampler::AudioResampler;
use std::{
    ffi::c_void,
    time::{Duration, Instant},
};

unsafe extern "C" {
    fn nanocodex_pcm_create() -> *mut c_void;
    fn nanocodex_pcm_destroy(handle: *mut c_void);
    fn nanocodex_pcm_begin(handle: *mut c_void, generation: u64) -> i32;
    fn nanocodex_pcm_write(
        handle: *mut c_void,
        generation: u64,
        data: *const i16,
        length: usize,
    ) -> i32;
    fn nanocodex_pcm_peak(handle: *mut c_void) -> u16;
    fn nanocodex_pcm_available(handle: *mut c_void) -> usize;
    fn nanocodex_pcm_status(handle: *mut c_void, generation: u64) -> i32;
    fn nanocodex_pcm_cancel(handle: *mut c_void, generation: u64) -> i32;
}

pub(super) struct Pcm {
    handle: *mut c_void,
    generation: u64,
    rate: u32,
    pending: Vec<i16>,
    resampler: AudioResampler,
    draining: bool,
    drained_at: Option<Instant>,
}
impl Pcm {
    /// Must immediately precede factory construction on the same thread.
    pub(super) fn new() -> Self {
        Self {
            handle: unsafe { nanocodex_pcm_create() },
            generation: 0,
            rate: 48000,
            pending: Vec::with_capacity(1440),
            resampler: AudioResampler::default(),
            draining: false,
            drained_at: None,
        }
    }
    pub(super) fn take_peak(&self) -> u16 {
        unsafe { nanocodex_pcm_peak(self.handle) }
    }

    pub(super) fn begin(&mut self, generation: u64, rate: u32) -> PcmStatus {
        if !matches!(rate, 16000 | 24000 | 48000) {
            return PcmStatus::Unsupported;
        }
        if unsafe { nanocodex_pcm_begin(self.handle, generation) } != 0 {
            return PcmStatus::Stale;
        }
        self.generation = generation;
        self.rate = rate;
        self.pending.clear();
        self.resampler = AudioResampler::default();
        self.draining = false;
        self.drained_at = None;
        PcmStatus::Ready
    }
    pub(super) fn write(&mut self, generation: u64, samples: &[i16]) -> PcmStatus {
        if generation != self.generation
            || self.draining
            || unsafe { nanocodex_pcm_status(self.handle, generation) } < 0
        {
            return PcmStatus::Stale;
        }
        if samples.is_empty() || samples.len() > MAX_PCM_SAMPLES {
            return PcmStatus::Unsupported;
        }
        let block = self.rate as usize / 100;
        let needed = (self.pending.len() + samples.len()) / block * 480;
        if unsafe { nanocodex_pcm_available(self.handle) } < needed {
            return PcmStatus::Busy;
        }
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= block {
            let output = self.resampler.remix_and_resample(
                &self.pending[..block],
                block as u32,
                1,
                self.rate,
                1,
                48000,
            );
            let status = unsafe {
                nanocodex_pcm_write(self.handle, generation, output.as_ptr(), output.len())
            };
            debug_assert_eq!(status, 0); // Single producer; callback can only free capacity.
            if status != 0 {
                return PcmStatus::Stale;
            }
            self.pending.drain(..block);
        }
        self.drained_at = None;
        PcmStatus::Ready
    }
    pub(super) fn drain(&mut self, generation: u64) -> PcmStatus {
        if generation != self.generation
            || unsafe { nanocodex_pcm_status(self.handle, generation) } < 0
        {
            return PcmStatus::Stale;
        }
        if !self.draining {
            // Flush the partial frame and sinc filter tail through the normal mixer.
            let block = self.rate as usize / 100;
            let padding = block * 2 - self.pending.len();
            let status = self.write(generation, &vec![0; padding]);
            if status != PcmStatus::Ready {
                return status;
            }
            self.draining = true;
        }
        if unsafe { nanocodex_pcm_status(self.handle, generation) } != 0 {
            return PcmStatus::Busy;
        }
        let drained = self.drained_at.get_or_insert_with(Instant::now);
        if drained.elapsed() < Duration::from_millis(100) {
            PcmStatus::Busy
        } else {
            PcmStatus::Ready
        }
    }
    pub(super) fn cancel(&mut self, generation: u64) -> PcmStatus {
        if unsafe { nanocodex_pcm_cancel(self.handle, generation) } != 0 {
            return PcmStatus::Stale;
        }
        self.pending.clear();
        self.draining = true;
        PcmStatus::Ready
    }
}
impl Drop for Pcm {
    fn drop(&mut self) {
        unsafe { nanocodex_pcm_destroy(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    unsafe extern "C" {
        fn nanocodex_pcm_test_render(handle: *mut c_void, data: *mut i16, capacity: usize)
        -> usize;
    }
    unsafe extern "C" {
        fn nanocodex_pcm_test_attached(handle: *mut c_void) -> bool;
    }
    #[test]
    fn repeated_factory_teardown_releases_mixer_after_success_and_cancel() {
        // Partial initialization must also release its thread-local pending state.
        drop(Pcm::new());
        for generation in 1..=3 {
            let mut pcm = Pcm::new();
            let factory = libwebrtc::peer_connection_factory::PeerConnectionFactory::default();
            assert!(unsafe { nanocodex_pcm_test_attached(pcm.handle) });
            assert_eq!(pcm.begin(generation, 48000), PcmStatus::Ready);
            assert_eq!(pcm.write(generation, &[5000; 480]), PcmStatus::Ready);
            if generation % 2 == 0 {
                assert_eq!(pcm.cancel(generation), PcmStatus::Ready);
            } else {
                let _ = render(&pcm);
            }
            drop(factory);
            let deadline = Instant::now() + Duration::from_secs(5);
            while unsafe { nanocodex_pcm_test_attached(pcm.handle) } {
                assert!(Instant::now() < deadline, "factory leaked its native mixer");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    fn render(pcm: &Pcm) -> [i16; 480] {
        let mut output = [0; 480];
        assert_eq!(
            unsafe { nanocodex_pcm_test_render(pcm.handle, output.as_mut_ptr(), output.len()) },
            480
        );
        output
    }
    #[test]
    fn mixer_consumes_external_pcm_and_cancel_fences_old_generations() {
        let mut pcm = Pcm::new();
        let _factory = libwebrtc::peer_connection_factory::PeerConnectionFactory::default();
        assert_eq!(pcm.begin(1, 48000), PcmStatus::Ready);
        assert_eq!(pcm.write(1, &[12000; 480]), PcmStatus::Ready);
        let output = render(&pcm);
        assert!(output.iter().all(|sample| *sample == 12000));
        assert_eq!(pcm.take_peak(), 12000);
        assert_eq!(pcm.take_peak(), 0);
        assert_eq!(pcm.write(1, &[9000; 480]), PcmStatus::Ready);
        assert_eq!(pcm.cancel(1), PcmStatus::Ready);
        assert!(render(&pcm).iter().all(|sample| *sample == 0));
        assert_eq!(pcm.write(1, &[5000; 480]), PcmStatus::Stale);
        assert_eq!(pcm.begin(1, 48000), PcmStatus::Stale);
        assert_eq!(pcm.begin(2, 48000), PcmStatus::Ready);
        assert_eq!(pcm.cancel(1), PcmStatus::Stale);
        assert_eq!(pcm.write(2, &[6000; 480]), PcmStatus::Ready);
        assert!(render(&pcm).iter().all(|sample| *sample == 6000));
    }
    #[test]
    fn queue_backpressure_does_not_consume_rejected_samples() {
        let mut pcm = Pcm::new();
        let _factory = libwebrtc::peer_connection_factory::PeerConnectionFactory::default();
        assert_eq!(pcm.begin(5, 48000), PcmStatus::Ready);
        for _ in 0..10 {
            assert_eq!(pcm.write(5, &[1000; 960]), PcmStatus::Ready);
        }
        assert_eq!(pcm.write(5, &[2000; 480]), PcmStatus::Busy);
        assert!(render(&pcm).iter().all(|sample| *sample == 1000));
        assert_eq!(pcm.write(5, &[2000; 480]), PcmStatus::Ready);
        for _ in 0..19 {
            assert!(render(&pcm).iter().all(|sample| *sample == 1000));
        }
        assert!(render(&pcm).iter().all(|sample| *sample == 2000));
    }
    #[test]
    fn resamples_split_24k_chunks_and_drains_partial_tail() {
        let mut pcm = Pcm::new();
        let _factory = libwebrtc::peer_connection_factory::PeerConnectionFactory::default();
        assert_eq!(pcm.begin(10, 24000), PcmStatus::Ready);
        for _ in 0..3 {
            assert_eq!(pcm.write(10, &[10000; 113]), PcmStatus::Ready);
        }
        assert!(render(&pcm).iter().any(|sample| sample.abs() > 9000));
        assert_eq!(pcm.drain(10), PcmStatus::Busy);
        assert_eq!(pcm.write(10, &[10000; 100]), PcmStatus::Stale);
        let _ = render(&pcm);
        let _ = render(&pcm);
        std::thread::sleep(Duration::from_millis(15));
        assert_eq!(pcm.drain(10), PcmStatus::Busy);
        std::thread::sleep(Duration::from_millis(105));
        assert_eq!(pcm.drain(10), PcmStatus::Ready);
    }
}

// Nanocodex external PCM ingress. Apache-2.0.
#include "livekit/nanocodex_pcm.h"
#include "modules/audio_mixer/audio_mixer_impl.h"
#include "rtc_base/ref_counted_object.h"
#include <array>
#include <cstdint>
#include <memory>
#include <mutex>
#include <chrono>

namespace {
// 200 ms at 48 kHz, independent of network chunk sizes. No callback allocation.
struct State {
  std::mutex mutex;
  std::array<int16_t, 9600> samples{};
  size_t head = 0, size = 0;
  uint64_t generation = 0;
  bool active = false;
  uint16_t peak = 0;
  webrtc::AudioMixer* attached_mixer = nullptr;
  std::chrono::steady_clock::time_point rendered_until{};
};
thread_local std::shared_ptr<State> pending;
class Mixer : public webrtc::AudioMixer, public webrtc::AudioMixer::Source {
 public:
  explicit Mixer(std::shared_ptr<State> state)
      : state_(std::move(state)), mixer_(webrtc::AudioMixerImpl::Create()) {
    mixer_->AddSource(this);
    state_->attached_mixer = this;
  }
  ~Mixer() override {
    mixer_->RemoveSource(this);
    std::lock_guard<std::mutex> lock(state_->mutex);
    state_->attached_mixer = nullptr;
  }
  int Ssrc() const override { return -1; }
  int PreferredSampleRate() const override { return 48000; }
  AudioFrameInfo GetAudioFrameWithInfo(int rate, webrtc::AudioFrame* frame) override {
    frame->UpdateFrame(0, nullptr, rate / 100, rate, webrtc::AudioFrame::kNormalSpeech, webrtc::AudioFrame::kVadUnknown, 1);
    return AudioFrameInfo::kMuted;
  }
  bool AddSource(webrtc::AudioMixer::Source* source) override { return mixer_->AddSource(source); }
  void RemoveSource(webrtc::AudioMixer::Source* source) override { mixer_->RemoveSource(source); }
  void Mix(size_t channels, webrtc::AudioFrame* frame) override {
    mixer_->Mix(channels, frame);
    // The default mixer can select 8/16/32/48 kHz. Ingress is normalized to
    // 48 kHz; pick exact phase positions for the requested 10 ms device block.
    std::unique_lock<std::mutex> lock(state_->mutex, std::try_to_lock);
    if (!lock.owns_lock() || !state_->active || state_->size == 0) return;
    const size_t available = std::min(state_->size, size_t(480));
    const size_t frames = frame->samples_per_channel();
    auto* data = frame->mutable_data();
    for (size_t i = 0; i < frames; ++i) {
      const size_t position = i * 480 / frames;
      if (position >= available) break;
      const int value = state_->samples[(state_->head + position) % 9600];
      state_->peak = std::max(state_->peak, static_cast<uint16_t>(std::abs(value)));
      for (size_t c = 0; c < channels; ++c) {
        const int mixed = int(data[i * channels + c]) + value;
        data[i * channels + c] = static_cast<int16_t>(std::max(-32768, std::min(32767, mixed)));
      }
    }
    state_->head = (state_->head + available) % 9600;
    state_->size -= available;
    // Includes the mixer frame. Hardware latency is accounted for separately
    // by the host's drain grace period; a physical DAC cannot be retracted.
    state_->rendered_until = std::chrono::steady_clock::now() + std::chrono::milliseconds(10);
  }
 private:
  std::shared_ptr<State> state_;
  webrtc::scoped_refptr<webrtc::AudioMixer> mixer_;
};
}
webrtc::scoped_refptr<webrtc::AudioMixer> nanocodex_take_pcm_mixer() {
  if (!pending) return nullptr;
  auto state = std::move(pending);
  return webrtc::make_ref_counted<Mixer>(std::move(state));
}
extern "C" {
void* nanocodex_pcm_create() {
  pending = std::make_shared<State>();
  return new std::shared_ptr<State>(pending);
}
void nanocodex_pcm_destroy(void* handle) {
  auto* state = static_cast<std::shared_ptr<State>*>(handle);
  if (pending == *state) pending.reset();
  delete state;
}
uint16_t nanocodex_pcm_peak(void* handle) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  auto peak = state->peak; state->peak = 0; return peak;
}
bool nanocodex_pcm_test_attached(void* handle) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  return state->attached_mixer != nullptr;
}
// Deterministic harness for the mixer actually attached to the factory.
// Test caller MUST retain that factory throughout this call. No device streams.
size_t nanocodex_pcm_test_render(void* handle, int16_t* data, size_t capacity) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  auto* mixer = state->attached_mixer;
  if (!mixer) return 0;
  webrtc::AudioFrame frame;
  mixer->Mix(1, &frame);
  const size_t count = std::min(capacity, frame.samples_per_channel());
  std::copy(frame.data(), frame.data() + count, data);
  return count;
}
// Begin requires monotonic nonzero generations. Cancel retires the generation.
int nanocodex_pcm_begin(void* handle, uint64_t generation) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  if (generation == 0 || generation <= state->generation) return -1;
  state->generation = generation; state->active = true;
  state->head = state->size = 0; state->peak = 0; return 0;
}
int nanocodex_pcm_write(void* handle, uint64_t generation, const int16_t* data, size_t length) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  if (!state->active || generation != state->generation) return -1;
  if (length > 9600 - state->size) return 1;
  for (size_t i = 0; i < length; ++i) state->samples[(state->head + state->size + i) % 9600] = data[i];
  state->size += length; return 0;
}
size_t nanocodex_pcm_available(void* handle) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  return 9600 - state->size;
}
int nanocodex_pcm_status(void* handle, uint64_t generation) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  if (!state->active || generation != state->generation) return -1;
  return state->size == 0 && std::chrono::steady_clock::now() >= state->rendered_until ? 0 : 1;
}
int nanocodex_pcm_cancel(void* handle, uint64_t generation) {
  auto state = *static_cast<std::shared_ptr<State>*>(handle);
  std::lock_guard<std::mutex> lock(state->mutex);
  if (generation != state->generation) return -1;
  state->active = false; state->head = state->size = 0; state->peak = 0; return 0;
}
}

//! Duration-based audio token estimates, ported verbatim from codex-rs
//! `utils/audio/src/lib.rs` (openai/codex 1427825c40): `ceil(seconds * 10)`,
//! or `ceil(url.len() / 4)` when the duration cannot be measured.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use sha1::{Digest, Sha1};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::Mutex;
use symphonia::core::{
    formats::{FormatOptions, TrackType, probe::Hint},
    io::MediaSourceStream,
    meta::MetadataOptions,
};

const AUDIO_TOKEN_ESTIMATE_CACHE_SIZE: usize = 32;
const AUDIO_TOKENS_PER_SECOND: f64 = 10.0;
const APPROX_BYTES_PER_TOKEN: usize = 4;

/// Most-recently-used entries at the back, like codex's 32-entry LRU keyed by
/// the SHA-1 of the audio URL. Memoization only; results are identical.
static AUDIO_TOKEN_ESTIMATE_CACHE: Mutex<VecDeque<([u8; 20], usize)>> = Mutex::new(VecDeque::new());

/// Estimates model tokens for an audio input from its decoded duration,
/// falling back to the data URL size when the duration cannot be measured.
#[must_use]
pub fn estimate_audio_token_count(audio_url: &str) -> usize {
    let key: [u8; 20] = Sha1::digest(audio_url.as_bytes()).into();
    if let Ok(mut cache) = AUDIO_TOKEN_ESTIMATE_CACHE.lock()
        && let Some(index) = cache.iter().position(|(cached, _)| *cached == key)
        && let Some(entry) = cache.remove(index)
    {
        cache.push_back(entry);
        return entry.1;
    }
    let tokens = uncached_audio_token_count(audio_url);
    if let Ok(mut cache) = AUDIO_TOKEN_ESTIMATE_CACHE.lock() {
        if cache.len() >= AUDIO_TOKEN_ESTIMATE_CACHE_SIZE {
            cache.pop_front();
        }
        cache.push_back((key, tokens));
    }
    tokens
}

fn uncached_audio_token_count(audio_url: &str) -> usize {
    let Some(duration_seconds) = audio_duration_seconds(audio_url) else {
        return approx_token_count(audio_url);
    };
    let token_count = (duration_seconds * AUDIO_TOKENS_PER_SECOND).ceil();
    if token_count >= usize::MAX as f64 {
        usize::MAX
    } else {
        token_count as usize
    }
}

const fn approx_token_count(text: &str) -> usize {
    text.len()
        .saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1))
        / APPROX_BYTES_PER_TOKEN
}

const fn canonical_audio_mime(mime: &str) -> Option<&'static str> {
    if mime.eq_ignore_ascii_case("audio/wav")
        || mime.eq_ignore_ascii_case("audio/x-wav")
        || mime.eq_ignore_ascii_case("audio/wave")
        || mime.eq_ignore_ascii_case("audio/vnd.wave")
    {
        Some("audio/wav")
    } else if mime.eq_ignore_ascii_case("audio/mpeg") || mime.eq_ignore_ascii_case("audio/mp3") {
        Some("audio/mpeg")
    } else if mime.eq_ignore_ascii_case("audio/mp4")
        || mime.eq_ignore_ascii_case("audio/m4a")
        || mime.eq_ignore_ascii_case("audio/x-m4a")
    {
        Some("audio/mp4")
    } else if mime.eq_ignore_ascii_case("audio/webm") {
        Some("audio/webm")
    } else if mime.eq_ignore_ascii_case("audio/ogg") {
        Some("audio/ogg")
    } else {
        None
    }
}

fn audio_duration_seconds(audio_url: &str) -> Option<f64> {
    let (metadata, payload) = audio_url.split_once(',')?;
    let metadata = metadata.get("data:".len()..)?;
    let mut metadata_parts = metadata.split(';');
    let canonical_mime = canonical_audio_mime(metadata_parts.next()?)?;
    if !metadata_parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return None;
    }

    let bytes = match BASE64_STANDARD.decode(payload) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::trace!(%error, "failed to decode audio payload for token estimation");
            return None;
        }
    };
    let media_source = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    hint.mime_type(canonical_mime);
    let format = match symphonia::default::get_probe().probe(
        &hint,
        media_source,
        FormatOptions::default(),
        MetadataOptions::default(),
    ) {
        Ok(format) => format,
        Err(error) => {
            tracing::trace!(%error, "failed to read audio duration for token estimation");
            return None;
        }
    };
    let track = format.default_track(TrackType::Audio)?;
    let timing = track.time_base.zip(track.duration).or_else(|| {
        format
            .media_info()
            .time_base
            .zip(format.media_info().duration)
    });
    let (time_base, duration) = timing?;
    let duration_seconds =
        duration.get() as f64 * f64::from(time_base.numer.get()) / f64::from(time_base.denom.get());
    duration_seconds.is_finite().then_some(duration_seconds)
}

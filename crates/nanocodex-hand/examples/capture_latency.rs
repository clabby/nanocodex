//! Observe the local display without saving or emitting image contents.
//! Requires the invoking application's existing OS screen-recording permission.
#[cfg(target_os = "macos")]
use std::time::Instant;

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter("nanocodex_hand=debug")
        .init();
    for sample in 0..10 {
        let began = Instant::now();
        let frame = nanocodex_hand::request(serde_json::json!({"action":"observe"}))?;
        println!(
            "{}",
            serde_json::json!({
                "sample": sample, "elapsed_ms": began.elapsed().as_secs_f64() * 1000.0,
                "status": frame["status"], "width": frame["width"], "height": frame["height"],
                "encoded_bytes": frame["jpeg"].as_str().map(str::len),
            })
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This capture probe requires macOS.");
}

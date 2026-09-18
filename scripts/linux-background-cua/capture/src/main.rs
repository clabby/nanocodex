mod hyprland;

mod capture;
use anyhow::{Context, Result};
use std::io::Write;
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let value = args.next().context("Expected exact Hyprland window address")?;
    anyhow::ensure!(args.next().is_none(), "Expected exactly one window address");
    let address = u64::from_str_radix(value.trim_start_matches("0x"), 16)?;
    anyhow::ensure!(address != 0, "Invalid window address");
    let image = capture::capture_toplevel_png(address)?;
    std::io::stdout().lock().write_all(&image)?;
    Ok(())
}

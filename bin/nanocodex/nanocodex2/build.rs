#[path = "../build_version.rs"]
mod build_version;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../build_version.rs");
    build_version::emit()?;
    println!("cargo:rerun-if-env-changed=NANOCODEX_LINUX_SCREEN_BUNDLE");
    println!("cargo:rerun-if-env-changed=PROFILE");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_ARCH");
    let destination =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR missing")?)
            .join("linux-screen-helpers.tar.gz");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        if let Some(source) = std::env::var_os("NANOCODEX_LINUX_SCREEN_BUNDLE") {
            let source = std::path::PathBuf::from(source);
            println!("cargo:rerun-if-changed={}", source.display());
            let bytes = std::fs::metadata(&source)?.len();
            if bytes == 0 || bytes > 64 * 1024 * 1024 {
                return Err("Linux screen helper bundle must be 1 byte through 64 MiB".into());
            }
            let architecture = std::env::var("CARGO_CFG_TARGET_ARCH")?;
            if !matches!(architecture.as_str(), "x86_64" | "aarch64") {
                return Err("Linux screen helper payload requires x86_64 or aarch64".into());
            }
            let verifier = std::path::PathBuf::from(
                std::env::var_os("CARGO_MANIFEST_DIR").ok_or("CARGO_MANIFEST_DIR missing")?,
            )
            .join("../../../scripts/tests/linux-screen-helpers-bundle.py");
            println!("cargo:rerun-if-changed={}", verifier.display());
            // Verify the staged copy, not a mutable caller path. The single
            // artifact we validate is exactly the one include_bytes! embeds.
            std::fs::copy(source, &destination)?;
            let status = std::process::Command::new("python3")
                .arg(&verifier)
                .arg("--verify-only")
                .arg("--architecture")
                .arg(&architecture)
                .arg(&destination)
                .status()
                .map_err(|error| {
                    format!(
                        "python3 is required to validate the Linux screen helper payload: {error}"
                    )
                })?;
            if !status.success() {
                return Err("Linux screen helper payload failed manifest/hash/ELF validation; refusing to embed it".into());
            }
        } else {
            // Only debug developer/test builds may omit the desktop payload.
            // Cargo reports custom release-derived profiles (e.g. nightly) as
            // PROFILE=release too, so all distributable builds fail closed.
            if std::env::var("PROFILE").as_deref() != Ok("debug") {
                return Err("distributable Linux Hand builds require NANOCODEX_LINUX_SCREEN_BUNDLE; run scripts/build-linux-screen-helpers.sh with --auto OUTPUT WORK_DIR (native prerequisites or Docker), then set the variable to OUTPUT. No empty payload will be shipped".into());
            }
            println!(
                "cargo:warning=Linux Wayland screen helpers are absent; set NANOCODEX_LINUX_SCREEN_BUNDLE for a distributable Hand"
            );
            std::fs::write(&destination, [])?;
        }
    } else {
        std::fs::write(&destination, [])?;
    }
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_OS");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_ENV");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        // Opus enables GCC stack protection. Include its runtime statically so
        // the standalone Windows Hand does not need an extra libssp DLL.
        println!("cargo:rustc-link-lib=static:+whole-archive=ssp");
    }
    Ok(())
}

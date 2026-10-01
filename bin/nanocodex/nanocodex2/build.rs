#[path = "../build_version.rs"]
mod build_version;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../build_version.rs");
    build_version::emit()?;
    println!("cargo:rerun-if-env-changed=NANOCODEX_LINUX_SCREEN_BUNDLE");
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
            std::fs::copy(source, &destination)?;
        } else {
            // Developer/test builds need not carry a desktop. Published Linux
            // releases set this variable in the helper build stage.
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

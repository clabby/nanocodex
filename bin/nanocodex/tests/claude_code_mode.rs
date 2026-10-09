//! Black-box shipped CLI journey; only Messages inference is synthetic.
#[test]
fn claude_code_mode_native_tools_permissions_and_shared_children() {
    let repository = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("python3")
        .arg(repository.join("scripts/tests/claude-code-mode-cli-journey.py"))
        .args(["--binary", env!("CARGO_BIN_EXE_nanocodex")])
        .current_dir(&repository)
        .output()
        .expect("run Claude Code Mode CLI journey");
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

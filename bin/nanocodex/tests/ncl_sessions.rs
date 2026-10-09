//! Local sessions, branches and side threads through the shipped CLI in tmux.
#[path = "support/local_cli.rs"]
mod local_cli;
use local_cli::local_cli;

#[cfg(target_os = "linux")]
#[test]
fn ncl_sessions_journey() {
    if std::process::Command::new("tmux").arg("-V").output().is_err() {
        eprintln!("skipping: the ncl sessions journey drives a real tmux terminal");
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("python3")
        .current_dir(&root)
        .arg(root.join("scripts/tests/ncl-sessions-journey.py"))
        .args(["--binary", local_cli()])
        .output()
        .expect("Python 3 is required for the ncl sessions journey");
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

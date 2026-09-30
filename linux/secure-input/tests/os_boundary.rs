#![cfg(target_os = "linux")]
use nanocodex_secure_input_linux::{Command, os};
use std::{
    io::Write,
    os::unix::{fs::symlink, net::UnixStream},
    time::{Duration, Instant},
};
#[test]
fn dumpability_and_core_disabled_before_secrets() {
    os::harden().unwrap();
    assert!(unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) } == 0);
    let mut limit = libc::rlimit {
        rlim_cur: 1,
        rlim_max: 1,
    };
    assert!(unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut limit) } == 0);
    assert!(limit.rlim_cur == 0 && limit.rlim_max == 0);
}
#[test]
fn peer_is_kernel_uid_and_pid_not_json() {
    let (a, _) = UnixStream::pair().unwrap();
    let (uid, pid) = os::peer(&a).unwrap();
    assert!(uid == unsafe { libc::getuid() });
    assert!(pid == std::process::id() as i32);
}
#[test]
fn protected_executable_rejects_user_owned_writable_symlink_and_dotdot() {
    assert!(os::protected("/usr/bin/true", false, None).is_ok());
    assert!(os::protected("/usr/bin/../bin/true", false, None).is_err());
    let directory = std::env::current_dir()
        .unwrap()
        .join("target")
        .join(format!("os-fixture-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o777)).unwrap();
    let owned = directory.join("owned");
    std::fs::write(&owned, b"non-secret").unwrap();
    assert!(os::protected(owned.to_str().unwrap(), false, None).is_err());
    let alias = directory.join("alias");
    symlink("/usr/bin/true", &alias).unwrap();
    assert!(os::protected(alias.to_str().unwrap(), false, None).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn os_frame_lf_eof_and_trailing_echo() {
    for (bytes, valid) in [
        (
            b"{\"operation\":\"cancel\",\"request_id\":\"x\"}\n".as_slice(),
            true,
        ),
        (
            b"{\"operation\":\"cancel\",\"request_id\":\"x\"}\nprivate-echo".as_slice(),
            false,
        ),
    ] {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        a.write_all(bytes).unwrap();
        a.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(os::frame(&mut b).is_ok() == valid);
    }
}
#[test]
fn absolute_deadline_rejects_slow_client() {
    let (_a, mut b) = UnixStream::pair().unwrap();
    let start = Instant::now();
    assert!(os::frame(&mut b).is_err());
    assert!(start.elapsed() >= Duration::from_secs(4) && start.elapsed() < Duration::from_secs(7));
}
#[test]
fn no_root_no_install_no_sudo_dispatch_and_no_output() {
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_nanocodex-secure-input"))
        .output()
        .unwrap();
    assert!(!child.status.success());
    assert!(child.stdout.is_empty() && child.stderr.is_empty());
    let askpass = std::env::current_dir().unwrap().join("target/test-askpass");
    if askpass.exists() {
        let output = std::process::Command::new(askpass)
            .args(["ignored", "extra"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
    }
    assert!(
        os::bind_command(&Command {
            executable: "/not-installed".into(),
            arguments: vec![],
            cwd: "/".into()
        })
        .is_err()
    );
}

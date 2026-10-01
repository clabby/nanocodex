//! Linux capture selection never borrows another user's login session. Environment
//! values are hints, not proof of a compositor: validate ownership and connect to
//! its Unix socket before selecting it. No process-global environment is changed.
use nanocodex_managed::ManagedError;
use std::{
    ffi::{OsStr, OsString},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Component, Path, PathBuf},
};

type Result<T> = std::result::Result<T, ManagedError>;
fn error(message: impl std::fmt::Display) -> ManagedError {
    ManagedError::Configuration(format!("Linux screen session: {message}"))
}

#[derive(Clone, Debug)]
pub(crate) struct WaylandSession {
    runtime: PathBuf,
    display: OsString,
    uid: u32,
}
pub(crate) enum Selection {
    Wayland(WaylandSession),
    PrivateDesktop,
}

pub(crate) fn select() -> Result<Selection> {
    let uid = nix::unistd::Uid::effective().as_raw();
    select_with(
        std::env::var_os("NANOCODEX_SCREEN_BACKEND").as_deref(),
        std::env::var_os("XDG_RUNTIME_DIR").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        &PathBuf::from(format!("/run/user/{uid}")),
        uid,
    )
}

fn select_with(
    backend: Option<&OsStr>,
    runtime: Option<&OsStr>,
    display: Option<&OsStr>,
    standard_runtime: &Path,
    uid: u32,
) -> Result<Selection> {
    let explicit = match backend {
        None => false,
        Some(value) if value == "default" || value == "auto" => false,
        Some(value) if value == "wayland" => true,
        // Preserve the private Xvfb override even in a valid Wayland session.
        Some(value) if value == "x11" || value == "xvfb" => {
            return Ok(Selection::PrivateDesktop);
        }
        Some(_) => {
            return Err(error(
                "backend must be default, auto, wayland, x11, or xvfb",
            ));
        }
    };
    let session = discover(runtime, display, standard_runtime, uid)?;
    match session {
        Some(session) => Ok(Selection::Wayland(session)),
        None if explicit => Err(error(
            "explicit Wayland backend requires a live same-uid compositor socket in a private runtime directory",
        )),
        None => Ok(Selection::PrivateDesktop),
    }
}

fn discover(
    runtime: Option<&OsStr>,
    display: Option<&OsStr>,
    standard_runtime: &Path,
    uid: u32,
) -> Result<Option<WaylandSession>> {
    let runtime = runtime.filter(|value| !value.is_empty()).map(PathBuf::from);
    let display = display.filter(|value| !value.is_empty());
    // Honour an unambiguous valid hint first. An invalid/stale inherited hint
    // cannot route capture to a foreign socket or force a Wayland downgrade.
    if let Some(display) = display {
        let directory = runtime.as_deref().unwrap_or(standard_runtime);
        if let Ok(session) = WaylandSession::validated(directory, display, uid) {
            return Ok(Some(session));
        }
    }
    // Scan only a validated inherited runtime and our own standard runtime.
    // In particular, do not enumerate /run/user or read /proc/*/environ.
    let mut sessions = Vec::new();
    let mut directories = Vec::new();
    if let Some(runtime) = runtime {
        directories.push(runtime);
    }
    if !directories.iter().any(|path| path == standard_runtime) {
        directories.push(standard_runtime.to_owned());
    }
    for directory in directories {
        if validate_runtime(&directory, uid).is_err() {
            continue;
        }
        let entries = std::fs::read_dir(&directory).map_err(error)?;
        for entry in entries {
            let entry = entry.map_err(error)?;
            let name = entry.file_name();
            // Lock files, nested paths and unrelated private IPC are not displays.
            let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix("wayland-")) else {
                continue;
            };
            if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            if let Ok(session) = WaylandSession::validated(&directory, &name, uid) {
                sessions.push(session);
            }
        }
    }
    match sessions.len() {
        0 => Ok(None),
        1 => Ok(sessions.pop()),
        _ => Err(error(
            "multiple live same-uid Wayland displays; set XDG_RUNTIME_DIR and WAYLAND_DISPLAY explicitly",
        )),
    }
}

fn validate_runtime(runtime: &Path, uid: u32) -> Result<()> {
    if !runtime.is_absolute() {
        return Err(error("runtime directory must be absolute"));
    }
    // Reject symlink traversal as well as a symlink at the directory itself.
    let mut walked = PathBuf::new();
    for component in runtime.components() {
        match component {
            Component::RootDir | Component::Normal(_) => walked.push(component.as_os_str()),
            _ => {
                return Err(error(
                    "runtime directory must not contain relative components",
                ));
            }
        }
        let metadata = std::fs::symlink_metadata(&walked).map_err(error)?;
        if metadata.file_type().is_symlink() {
            return Err(error("runtime directory must not traverse symlinks"));
        }
    }
    let metadata = std::fs::symlink_metadata(runtime).map_err(error)?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(error(
            "runtime directory must be a private same-uid directory",
        ));
    }
    Ok(())
}

impl WaylandSession {
    fn validated(runtime: &Path, display: &OsStr, uid: u32) -> Result<Self> {
        let display_path = Path::new(display);
        // libwayland permits absolute display paths, but only direct children of
        // the validated runtime are accepted here. Never accept ../ or symlinks.
        let name = if display_path.is_absolute() {
            if display_path.parent() != Some(runtime) {
                return Err(error(
                    "display socket must be inside its private runtime directory",
                ));
            }
            display_path
                .file_name()
                .ok_or_else(|| error("empty display"))?
        } else {
            let mut components = display_path.components();
            match (components.next(), components.next()) {
                (Some(Component::Normal(name)), None) => name,
                _ => return Err(error("display must name a single socket")),
            }
        };
        let session = Self {
            runtime: runtime.to_owned(),
            display: name.to_owned(),
            uid,
        };
        session.validate()?;
        Ok(session)
    }

    fn validate(&self) -> Result<()> {
        use nix::sys::socket::{
            AddressFamily, SockFlag, SockType, UnixAddr, connect, getsockopt, socket,
            sockopt::PeerCredentials,
        };
        use std::os::fd::AsRawFd;
        validate_runtime(&self.runtime, self.uid)?;
        let path = self.runtime.join(&self.display);
        let before = std::fs::symlink_metadata(&path).map_err(error)?;
        if !before.file_type().is_socket() || before.uid() != self.uid {
            return Err(error("display must be a same-uid non-symlink Unix socket"));
        }
        // Nonblocking connect bounds discovery even for a full listener backlog;
        // a stale pathname is insufficient evidence of a running compositor.
        let socket = socket(
            AddressFamily::Unix,
            SockType::Stream,
            SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK,
            None,
        )
        .map_err(error)?;
        let address = UnixAddr::new(&path).map_err(error)?;
        connect(socket.as_raw_fd(), &address).map_err(error)?;
        let peer = getsockopt(&socket, PeerCredentials).map_err(error)?;
        if peer.uid() != self.uid {
            return Err(error("Wayland compositor peer has a different uid"));
        }
        let after = std::fs::symlink_metadata(&path).map_err(error)?;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(error("display socket changed during validation"));
        }
        Ok(())
    }

    // Legacy opt-in text helpers inherit their child environment. Require it
    // to name this captured session; never send text to a different compositor.
    // Default Waymote IME delivery already uses the configured capture child.
    pub(crate) fn validate_inherited_text_session(&self) -> Result<()> {
        self.validate()?;
        self.validate_text_environment(
            std::env::var_os("XDG_RUNTIME_DIR").as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        )
    }

    fn validate_text_environment(
        &self,
        runtime: Option<&OsStr>,
        display: Option<&OsStr>,
    ) -> Result<()> {
        let runtime = runtime
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error("opt-in text helpers require the captured XDG_RUNTIME_DIR"))?;
        let display = display
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error("opt-in text helpers require the captured WAYLAND_DISPLAY"))?;
        let inherited = Self::validated(Path::new(runtime), display, self.uid)?;
        if inherited.runtime != self.runtime || inherited.display != self.display {
            return Err(error(
                "opt-in text helper environment differs from the captured Wayland session",
            ));
        }
        Ok(())
    }

    pub(crate) fn configure(&self, command: &mut tokio::process::Command) -> Result<()> {
        self.validate()?;
        command
            .env("XDG_RUNTIME_DIR", &self.runtime)
            .env("WAYLAND_DISPLAY", &self.display);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    };

    struct Fixture {
        directory: tempfile::TempDir,
        uid: u32,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            Self {
                directory,
                uid: nix::unistd::Uid::effective().as_raw(),
            }
        }
        fn socket(&self, name: &str) -> UnixListener {
            UnixListener::bind(self.directory.path().join(name)).unwrap()
        }
        fn select(
            &self,
            backend: Option<&str>,
            runtime: Option<&OsStr>,
            display: Option<&str>,
        ) -> Result<Selection> {
            select_with(
                backend.map(OsStr::new),
                runtime,
                display.map(OsStr::new),
                self.directory.path(),
                self.uid,
            )
        }
    }

    // Session discovery cannot be exercised against a real login in CI without
    // desktop access. Real private Unix listeners exercise liveness and peer uid
    // checks while never connecting to or injecting into the user's compositor.
    #[test]
    fn default_and_explicit_backend_compatibility() {
        let f = Fixture::new();
        assert!(matches!(
            f.select(None, None, None).unwrap(),
            Selection::PrivateDesktop
        ));
        assert!(f.select(Some("wayland"), None, None).is_err());
        let _socket = f.socket("wayland-0");
        for backend in [None, Some("default"), Some("auto"), Some("wayland")] {
            assert!(matches!(
                f.select(backend, None, None).unwrap(),
                Selection::Wayland(_)
            ));
        }
        for backend in ["x11", "xvfb"] {
            assert!(matches!(
                f.select(Some(backend), Some(OsStr::new("/invalid")), Some("stale"))
                    .unwrap(),
                Selection::PrivateDesktop
            ));
        }
        for backend in ["", "typo"] {
            assert!(f.select(Some(backend), None, None).is_err());
        }
    }

    #[test]
    fn empty_stale_invalid_and_foreign_hints_never_become_sessions() {
        let f = Fixture::new();
        let stale = f.socket("wayland-0");
        drop(stale);
        for display in [
            None,
            Some(""),
            Some("wayland-0"),
            Some("../wayland-0"),
            Some("/foreign/wayland-0"),
        ] {
            assert!(matches!(
                f.select(None, Some(OsStr::new("")), display).unwrap(),
                Selection::PrivateDesktop
            ));
            assert!(
                f.select(Some("wayland"), Some(OsStr::new("")), display)
                    .is_err()
            );
        }
        std::fs::write(f.directory.path().join("wayland-9"), b"not a socket").unwrap();
        assert!(
            WaylandSession::validated(f.directory.path(), OsStr::new("wayland-9"), f.uid).is_err()
        );
        let _live = f.socket("wayland-1");
        assert!(
            WaylandSession::validated(
                f.directory.path(),
                f.directory.path().join("wayland-1").as_os_str(),
                f.uid
            )
            .is_ok()
        );
        assert!(
            WaylandSession::validated(
                f.directory.path(),
                OsStr::new("wayland-1"),
                f.uid.wrapping_add(1)
            )
            .is_err()
        );
        // A bad inherited runtime cannot block discovery of our own fallback.
        assert!(matches!(
            f.select(None, Some(OsStr::new("/foreign")), Some("stale"))
                .unwrap(),
            Selection::Wayland(_)
        ));
        std::fs::set_permissions(f.directory.path(), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        assert!(matches!(
            f.select(None, None, Some("wayland-1")).unwrap(),
            Selection::PrivateDesktop
        ));
        assert!(f.select(Some("wayland"), None, Some("wayland-1")).is_err());
    }

    #[test]
    fn symlink_runtime_socket_and_ambiguous_sessions_are_rejected() {
        let f = Fixture::new();
        let _one = f.socket("wayland-0");
        let _two = f.socket("wayland-1");
        assert!(f.select(None, None, None).is_err());
        assert!(f.select(Some("wayland"), None, Some("invalid")).is_err());
        let selected = f.select(None, None, Some("wayland-1")).unwrap();
        let Selection::Wayland(session) = selected else {
            panic!("expected session")
        };
        assert_eq!(session.display, "wayland-1");
        let outer = Fixture::new();
        let link = outer.directory.path().join("runtime");
        symlink(f.directory.path(), &link).unwrap();
        assert!(WaylandSession::validated(&link, OsStr::new("wayland-0"), f.uid).is_err());
        symlink(
            f.directory.path().join("wayland-0"),
            outer.directory.path().join("wayland-0"),
        )
        .unwrap();
        assert!(
            outer
                .select(Some("wayland"), None, Some("wayland-0"))
                .is_err()
        );
    }

    #[test]
    fn child_environment_is_captured_and_revalidated_without_global_mutation() {
        let f = Fixture::new();
        let live = f.socket("wayland-0");
        let Selection::Wayland(session) = f.select(None, None, None).unwrap() else {
            panic!("expected session")
        };
        let _other = f.socket("wayland-1");
        assert!(session.validate_text_environment(None, None).is_err());
        assert!(
            session
                .validate_text_environment(Some(OsStr::new("")), Some(OsStr::new("")))
                .is_err()
        );
        assert!(
            session
                .validate_text_environment(
                    Some(f.directory.path().as_os_str()),
                    Some(OsStr::new("wayland-0"))
                )
                .is_ok()
        );
        assert!(
            session
                .validate_text_environment(
                    Some(f.directory.path().as_os_str()),
                    Some(OsStr::new("wayland-1"))
                )
                .is_err()
        );
        let before_runtime = std::env::var_os("XDG_RUNTIME_DIR");
        let before_display = std::env::var_os("WAYLAND_DISPLAY");
        let mut child = tokio::process::Command::new("/bin/sh");
        child.args([
            "-c",
            "printf '%s\n%s\n' \"$XDG_RUNTIME_DIR\" \"$WAYLAND_DISPLAY\"",
        ]);
        session.configure(&mut child).unwrap();
        let environment: Vec<_> = child.as_std().get_envs().collect();
        assert!(environment.contains(&(
            OsStr::new("XDG_RUNTIME_DIR"),
            Some(f.directory.path().as_os_str())
        )));
        assert!(
            environment.contains(&(OsStr::new("WAYLAND_DISPLAY"), Some(OsStr::new("wayland-0"))))
        );
        let output = child.as_std_mut().output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            format!("{}\nwayland-0\n", f.directory.path().display()).into_bytes()
        );
        assert_eq!(std::env::var_os("XDG_RUNTIME_DIR"), before_runtime);
        assert_eq!(std::env::var_os("WAYLAND_DISPLAY"), before_display);
        drop(live);
        assert!(
            session.configure(&mut child).is_err(),
            "recovery must not trust stale captured socket"
        );
    }
}

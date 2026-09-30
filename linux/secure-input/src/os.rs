//! Linux-only root boundary. No user-provided path selects configuration or keys.
use crate::{Command, MAX_FRAME, Rejected, Result};
use std::{
    ffi::CString,
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            net::UnixStream,
        },
    },
    path::{Component, Path},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
pub const CONFIG_DIR: &str = "/etc/nanocodex-secure-input";
pub const CONFIG: &str = "/etc/nanocodex-secure-input/configuration.json";
pub const HELPER: &str = "/usr/libexec/nanocodex-secure-input";
pub const ASKPASS: &str = "/usr/libexec/nanocodex-secure-askpass";
pub const RUN_DIR: &str = "/run/nanocodex-secure-input";
pub const SOCKET: &str = "/run/nanocodex-secure-input.sock";
unsafe extern "C" {
    fn nc_harden() -> libc::c_int;
    fn nc_secure_sudo(
        uid: u32,
        cwd: *const libc::c_char,
        exe: *const libc::c_char,
        args: *const *const libc::c_char,
        count: usize,
        secret: *const u8,
        size: usize,
    ) -> libc::c_int;
}
pub fn harden() -> Result<()> {
    if unsafe { nc_harden() } == 0 {
        Ok(())
    } else {
        Err(Rejected)
    }
}
pub fn root() -> Result<()> {
    if unsafe { libc::getuid() } == 0 && unsafe { libc::geteuid() } == 0 {
        Ok(())
    } else {
        Err(Rejected)
    }
}
/// Fail closed if UID transitions could reset dumpability to an unsafe policy.
pub fn safe_dump_policy() -> Result<()> {
    if fs::read_to_string("/proc/sys/fs/suid_dumpable")
        .map_err(|_| Rejected)?
        .trim()
        == "0"
    {
        Ok(())
    } else {
        Err(Rejected)
    }
}
/// Every component is opened relative to its verified predecessor, O_NOFOLLOW.
/// Root ownership and no group/other writes means non-root cannot race replacement.
pub fn protected(path: &str, directory: bool, mode: Option<u32>) -> Result<File> {
    let p = Path::new(path);
    if !p.is_absolute() || path.contains('\0') || path.split('/').any(|c| c == "." || c == "..") {
        return Err(Rejected);
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|_| Rejected)?;
    let parts = p
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect::<Vec<_>>();
    check(&file, true, None)?;
    for (i, part) in parts.iter().enumerate() {
        use std::os::unix::ffi::OsStrExt;
        let name = CString::new(part.as_bytes()).map_err(|_| Rejected)?;
        let fd = unsafe {
            libc::openat(
                file.as_raw_fd(),
                name.as_ptr(),
                libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(Rejected);
        }
        use std::os::fd::FromRawFd;
        file = unsafe { File::from_raw_fd(fd) };
        let last = i + 1 == parts.len();
        check(
            &file,
            if last { directory } else { true },
            if last { mode } else { None },
        )?;
    }
    if parts.is_empty() {
        check(&file, directory, mode)?;
    }
    Ok(file)
}
fn check(file: &File, directory: bool, mode: Option<u32>) -> Result<()> {
    let m = file.metadata().map_err(|_| Rejected)?;
    if m.uid() != 0
        || m.mode() & 0o022 != 0
        || (if directory { !m.is_dir() } else { !m.is_file() })
        || mode.is_some_and(|n| m.mode() & 0o7777 != n)
    {
        Err(Rejected)
    } else {
        Ok(())
    }
}
pub fn installation() -> Result<()> {
    protected(HELPER, false, Some(0o755))?;
    protected(ASKPASS, false, Some(0o4755))?;
    // /proc/self/exe resolves a kernel reference, not a caller path. Match installed inode.
    let actual = fs::metadata("/proc/self/exe").map_err(|_| Rejected)?;
    let expected = protected(HELPER, false, None)?
        .metadata()
        .map_err(|_| Rejected)?;
    if (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
        return Err(Rejected);
    }
    Ok(())
}
pub fn read_config() -> Result<Zeroizing<Vec<u8>>> {
    protected(CONFIG_DIR, true, Some(0o700))?;
    let pinned = protected(CONFIG, false, Some(0o600))?
        .metadata()
        .map_err(|_| Rejected)?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(CONFIG)
        .map_err(|_| Rejected)?;
    let meta = file.metadata().map_err(|_| Rejected)?;
    if (meta.dev(), meta.ino()) != (pinned.dev(), pinned.ino()) || meta.nlink() != 1 {
        return Err(Rejected);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::Read::by_ref(&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| Rejected)?;
    if bytes.len() > 4096 {
        return Err(Rejected);
    }
    Ok(bytes)
}
pub struct Bound {
    dev: u64,
    ino: u64,
}
pub fn bind_command(command: &Command) -> Result<Bound> {
    let file = protected(&command.executable, false, None)?;
    let m = file.metadata().map_err(|_| Rejected)?;
    if m.mode() & 0o111 == 0 {
        return Err(Rejected);
    }
    Ok(Bound {
        dev: m.dev(),
        ino: m.ino(),
    })
}
pub fn execute(command: &Command, uid: u32, secret: &[u8], bound: Bound) -> Result<i32> {
    safe_dump_policy()?;
    let current = bind_command(command)?;
    if (current.dev, current.ino) != (bound.dev, bound.ino) {
        return Err(Rejected);
    }
    let exe = CString::new(command.executable.as_str()).map_err(|_| Rejected)?;
    let cwd = CString::new(command.cwd.as_str()).map_err(|_| Rejected)?;
    let args = command
        .arguments
        .iter()
        .map(|s| CString::new(s.as_str()).map_err(|_| Rejected))
        .collect::<Result<Vec<_>>>()?;
    let pointers = args.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
    let code = unsafe {
        nc_secure_sudo(
            uid,
            cwd.as_ptr(),
            exe.as_ptr(),
            pointers.as_ptr(),
            pointers.len(),
            secret.as_ptr(),
            secret.len(),
        )
    };
    if code < 0 { Err(Rejected) } else { Ok(code) }
}
pub fn peer(stream: &UnixStream) -> Result<(u32, i32)> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(Rejected);
    }
    Ok((cred.uid, cred.pid))
}
/// LF plus EOF is mandatory. Poll uses one monotonic absolute deadline, so a
/// slowloris cannot extend admission by sending individual bytes.
pub fn frame(stream: &mut UnixStream) -> Result<Vec<u8>> {
    let until = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    stream.set_nonblocking(true).map_err(|_| Rejected)?;
    loop {
        let remaining = until
            .checked_duration_since(Instant::now())
            .ok_or(Rejected)?;
        let mut poll = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll, 1, remaining.as_millis().max(1) as i32) };
        if result <= 0 {
            return Err(Rejected);
        }
        let mut chunk = [0u8; 1024];
        let n = match stream.read(&mut chunk) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(_) => return Err(Rejected),
        };
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > MAX_FRAME {
            return Err(Rejected);
        }
    }
    crate::read_frame(bytes.as_slice()).map_err(|_| Rejected)?;
    stream.set_nonblocking(false).map_err(|_| Rejected)?;
    Ok(bytes)
}
pub fn respond(stream: &mut UnixStream, bytes: &[u8]) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.write_all(bytes);
    let _ = stream.write_all(b"\n");
}

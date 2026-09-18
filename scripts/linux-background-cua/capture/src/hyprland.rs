//! Attest that named Wayland and IPC sockets belong to the same selected compositor.
use anyhow::{Context, Result, bail};
use std::{os::fd::{AsRawFd, RawFd}, path::PathBuf, time::Duration};
fn connect(path: PathBuf) -> Result<std::os::unix::net::UnixStream> {
    let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
    socket.connect_timeout(&socket2::SockAddr::unix(path)?, Duration::from_secs(2))?;
    let fd: std::os::fd::OwnedFd = socket.into();
    Ok(fd.into())
}
fn runtime() -> Result<PathBuf> {
    let path = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").context("missing XDG_RUNTIME_DIR")?);
    anyhow::ensure!(path.is_absolute(), "XDG_RUNTIME_DIR must be absolute");
    Ok(path)
}
fn peer_pid(fd: RawFd) -> Result<libc::pid_t> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) };
    if result != 0 || len as usize != std::mem::size_of::<libc::ucred>() || cred.pid <= 0 || cred.uid != unsafe { libc::geteuid() } {
        bail!("could not verify same-user compositor peer");
    }
    Ok(cred.pid)
}
pub fn wayland_connection() -> Result<wayland_client::Connection> {
    anyhow::ensure!(std::env::var_os("WAYLAND_SOCKET").is_none(), "inherited Wayland fd is unsupported");
    let display = PathBuf::from(std::env::var_os("WAYLAND_DISPLAY").context("missing WAYLAND_DISPLAY")?);
    let path = if display.is_absolute() { display } else {
        anyhow::ensure!(display.components().count() == 1, "invalid Wayland socket name");
        runtime()?.join(display)
    };
    Ok(wayland_client::Connection::from_socket(connect(path)?)?)
}
pub fn verify_capture_peer(connection: &wayland_client::Connection) -> Result<()> {
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").context("missing compositor instance")?;
    anyhow::ensure!(!signature.is_empty() && signature.bytes().all(|b|b.is_ascii_alphanumeric() || b == b'_'), "invalid compositor instance");
    let ipc = connect(runtime()?.join("hypr").join(signature).join(".socket.sock"))?;
    anyhow::ensure!(peer_pid(ipc.as_raw_fd())? == peer_pid(connection.backend().poll_fd().as_raw_fd())?, "capture and IPC refer to different compositors");
    Ok(())
}

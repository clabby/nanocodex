#![cfg(target_os = "linux")]
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use nanocodex_secure_input_linux::{
    Admission, Broker, Command, Envelope, Rejected, Request, Result, decode, os,
};
use p256::ecdsa::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixListener,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    approval_public_key: String,
    identity_private_key: String,
    transport_uid: u32,
    sudo_uid: u32,
}
impl Drop for Config {
    fn drop(&mut self) {
        self.identity_private_key.zeroize();
    }
}
fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_millis() as u64)
        .map_err(|_| Rejected)
}
fn configuration() -> Result<(VerifyingKey, SigningKey, u32, u32)> {
    let data = os::read_config()?;
    let config: Config = serde_json::from_slice(&data).map_err(|_| Rejected)?;
    if config.transport_uid == 0 || config.sudo_uid == 0 {
        return Err(Rejected);
    }
    let approval = VerifyingKey::from_sec1_bytes(&decode(&config.approval_public_key, 65, 65)?)
        .map_err(|_| Rejected)?;
    let identity = Zeroizing::new(decode(&config.identity_private_key, 32, 32)?);
    let identity = SigningKey::from_slice(&identity).map_err(|_| Rejected)?;
    Ok((approval, identity, config.transport_uid, config.sudo_uid))
}
fn enroll(public: &str, transport: &str, sudo: &str) -> Result<()> {
    // Called only by trusted LOCAL root admin at a physical TTY, never a Hand.
    // This is deliberate friction, not proof against an already compromised root.
    if unsafe { libc::isatty(0) } != 1 || unsafe { libc::isatty(1) } != 1 {
        return Err(Rejected);
    }
    let transport_uid = transport.parse::<u32>().map_err(|_| Rejected)?;
    let sudo_uid = sudo.parse::<u32>().map_err(|_| Rejected)?;
    if transport_uid == 0
        || sudo_uid == 0
        || unsafe { libc::getpwuid(transport_uid) }.is_null()
        || unsafe { libc::getpwuid(sudo_uid) }.is_null()
    {
        return Err(Rejected);
    }
    VerifyingKey::from_sec1_bytes(&decode(public, 65, 65)?).map_err(|_| Rejected)?;
    os::protected("/etc", true, None)?;
    match fs::create_dir(os::CONFIG_DIR) {
        Ok(()) => fs::set_permissions(os::CONFIG_DIR, fs::Permissions::from_mode(0o700))
            .map_err(|_| Rejected)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(Rejected),
    }
    os::protected(os::CONFIG_DIR, true, Some(0o700))?;
    let identity = SigningKey::random(&mut OsRng);
    let config = Config {
        approval_public_key: public.into(),
        identity_private_key: B64.encode(identity.to_bytes()),
        transport_uid,
        sudo_uid,
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&config).map_err(|_| Rejected)?);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(os::CONFIG)
        .map_err(|_| Rejected)?;
    file.write_all(&bytes).map_err(|_| Rejected)?;
    file.sync_all().map_err(|_| Rejected)?;
    fs::File::open(os::CONFIG_DIR)
        .map_err(|_| Rejected)?
        .sync_all()
        .map_err(|_| Rejected)?;
    // Public enrollment fingerprint only. Pin out-of-band, not via Hand output.
    println!(
        "{}",
        B64.encode(identity.verifying_key().to_encoded_point(false).as_bytes())
    );
    Ok(())
}
fn run() -> Result<()> {
    os::root()?;
    os::harden()?;
    os::safe_dump_policy()?;
    os::installation()?;
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 5 && args[1] == "--enroll" {
        return enroll(&args[2], &args[3], &args[4]);
    }
    if args.len() != 1 {
        return Err(Rejected);
    }
    let (approval, identity, transport_uid, sudo_uid) = configuration()?;
    os::protected("/run", true, None)?;
    if !std::path::Path::new(os::RUN_DIR).exists() {
        fs::create_dir(os::RUN_DIR).map_err(|_| Rejected)?;
        fs::set_permissions(os::RUN_DIR, fs::Permissions::from_mode(0o700))
            .map_err(|_| Rejected)?;
    }
    os::protected(os::RUN_DIR, true, Some(0o700))?;
    match fs::symlink_metadata(os::SOCKET) {
        Ok(m) => {
            use std::os::unix::fs::FileTypeExt;
            if !m.file_type().is_socket() || m.uid() != 0 {
                return Err(Rejected);
            }
            fs::remove_file(os::SOCKET).map_err(|_| Rejected)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Rejected),
    }
    let listener = UnixListener::bind(os::SOCKET).map_err(|_| Rejected)?;
    fs::set_permissions(os::SOCKET, fs::Permissions::from_mode(0o666)).map_err(|_| Rejected)?;
    let mut broker = Broker::new(approval, identity);
    let mut admission = Admission::default();
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let Ok((uid, _)) = os::peer(&stream) else {
            continue;
        };
        if uid != transport_uid || !admission.admit(uid) {
            continue;
        }
        let result = (|| -> Result<Vec<u8>> {
            let bytes = os::frame(&mut stream)?;
            let request: Request = serde_json::from_slice(&bytes).map_err(|_| Rejected)?;
            match request {
                Request::Prepare {
                    executable,
                    arguments,
                    cwd,
                } => {
                    let command = Command {
                        executable,
                        arguments,
                        cwd,
                    };
                    let bound = os::bind_command(&command)?;
                    serde_json::to_vec(&broker.prepare(command, sudo_uid, now()?, bound)?)
                        .map_err(|_| Rejected)
                }
                Request::Cancel { request_id } => {
                    serde_json::to_vec(&broker.cancel(&request_id, sudo_uid)?).map_err(|_| Rejected)
                }
                Request::Submit {
                    request_id,
                    ephemeral_public_key,
                    ciphertext,
                    signature,
                } => serde_json::to_vec(&broker.submit(
                    Envelope {
                        request_id,
                        ephemeral_public_key,
                        ciphertext,
                        signature,
                    },
                    sudo_uid,
                    now()?,
                    os::execute,
                )?)
                .map_err(|_| Rejected),
            }
        })();
        os::respond(
            &mut stream,
            &result.unwrap_or_else(|_| b"{\"status\":\"rejected\"}".to_vec()),
        );
    }
    Err(Rejected)
}
fn main() {
    unsafe {
        libc::umask(0o077);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    // No diagnostics: errors cannot reflect secrets, ciphertext, or rejected input.
    if run().is_err() {
        std::process::exit(78)
    }
}

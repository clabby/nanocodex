//! Wire-compatible, ciphertext-only broker. Root OS recipient lives in main.rs.
//! Never derive enrollment from a Hand response; the caller supplies pinned keys.
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdh::diffie_hellman,
    ecdsa::{
        Signature, SigningKey, VerifyingKey,
        signature::{Signer, Verifier},
    },
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{self, Read},
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};
pub const MAX_FRAME: usize = 32768;
pub const TTL_MS: u64 = 300000;
#[derive(Debug)]
pub struct Rejected;
pub type Result<T> = std::result::Result<T, Rejected>;
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub executable: String,
    pub arguments: Vec<String>,
    pub cwd: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ticket {
    pub request_id: String,
    pub command_digest: String,
    pub public_key: String,
    pub expires_at: u64,
    pub uid: u32,
    pub command: Command,
    pub helper_signature: String,
}
impl Ticket {
    pub fn signing_data(&self) -> Vec<u8> {
        format!(
            "nanocodex-secure-sudo-ticket-v1\n{}\n{}\n{}\n{}\n{}",
            self.request_id, self.command_digest, self.public_key, self.expires_at, self.uid
        )
        .into_bytes()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub request_id: String,
    pub ephemeral_public_key: String,
    pub ciphertext: String,
    pub signature: String,
}
impl Envelope {
    pub fn signing_data(&self) -> Vec<u8> {
        format!(
            "nanocodex-secure-sudo-v1\n{}\n{}\n{}",
            self.request_id, self.ephemeral_public_key, self.ciphertext
        )
        .into_bytes()
    }
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Prepare {
        executable: String,
        arguments: Vec<String>,
        cwd: String,
    },
    Submit {
        request_id: String,
        ephemeral_public_key: String,
        ciphertext: String,
        signature: String,
    },
    Cancel {
        request_id: String,
    },
}
#[derive(Serialize)]
pub struct Receipt {
    pub request_id: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}
#[derive(Serialize)]
struct Binding<'a> {
    arguments: &'a [String],
    cwd: &'a str,
    executable: &'a str,
    uid: u32,
}
pub fn command_digest(command: &Command, uid: u32) -> Result<String> {
    let json = serde_json::to_vec(&Binding {
        arguments: &command.arguments,
        cwd: &command.cwd,
        executable: &command.executable,
        uid,
    })
    .map_err(|_| Rejected)?;
    Ok(B64.encode(Sha256::digest(json)))
}
pub fn decode(value: &str, min: usize, max: usize) -> Result<Vec<u8>> {
    if value.len() > max.div_ceil(3) * 4 {
        return Err(Rejected);
    }
    let bytes = B64.decode(value).map_err(|_| Rejected)?;
    if bytes.len() < min || bytes.len() > max || B64.encode(&bytes) != value {
        return Err(Rejected);
    }
    Ok(bytes)
}
struct Pending<T> {
    ticket: Ticket,
    key: SecretKey,
    bound: T,
    deadline: Instant,
}
pub struct Broker<T> {
    pending: HashMap<String, Pending<T>>,
    approval: VerifyingKey,
    identity: SigningKey,
}
impl<T> Broker<T> {
    pub fn new(approval: VerifyingKey, identity: SigningKey) -> Self {
        Self {
            pending: HashMap::new(),
            approval,
            identity,
        }
    }
    pub fn prepare(&mut self, command: Command, uid: u32, now: u64, bound: T) -> Result<Ticket> {
        self.pending
            .retain(|_, p| p.ticket.expires_at > now && p.deadline > Instant::now());
        if uid == 0
            || self.pending.len() >= 32
            || self
                .pending
                .values()
                .filter(|p| p.ticket.uid == uid)
                .count()
                >= 4
            || command.arguments.len() > 128
            || !valid_path(&command.executable)
            || !valid_path(&command.cwd)
            || command
                .arguments
                .iter()
                .any(|a| a.len() > 4096 || a.contains('\0'))
        {
            return Err(Rejected);
        }
        let key = SecretKey::random(&mut OsRng);
        let mut ticket = Ticket {
            request_id: uuid::Uuid::new_v4().to_string(),
            command_digest: command_digest(&command, uid)?,
            public_key: B64.encode(key.public_key().to_encoded_point(false).as_bytes()),
            expires_at: now.checked_add(TTL_MS).ok_or(Rejected)?,
            uid,
            command,
            helper_signature: String::new(),
        };
        let signature: Signature = self.identity.sign(&ticket.signing_data());
        ticket.helper_signature = B64.encode(signature.to_bytes());
        self.pending.insert(
            ticket.request_id.clone(),
            Pending {
                ticket: ticket.clone(),
                key,
                bound,
                deadline: Instant::now() + Duration::from_millis(TTL_MS),
            },
        );
        Ok(ticket)
    }
    pub fn cancel(&mut self, id: &str, uid: u32) -> Result<Receipt> {
        if self.pending.get(id).is_none_or(|p| p.ticket.uid != uid) {
            return Err(Rejected);
        }
        self.pending.remove(id);
        Ok(Receipt {
            request_id: id.into(),
            status: "cancelled",
            exit_code: None,
        })
    }
    pub fn submit(
        &mut self,
        envelope: Envelope,
        uid: u32,
        now: u64,
        execute: impl FnOnce(&Command, u32, &[u8], T) -> Result<i32>,
    ) -> Result<Receipt> {
        let item = self.pending.get(&envelope.request_id).ok_or(Rejected)?;
        if uid != item.ticket.uid
            || now >= item.ticket.expires_at
            || Instant::now() >= item.deadline
        {
            return Err(Rejected);
        }
        let sig =
            Signature::from_slice(&decode(&envelope.signature, 64, 64)?).map_err(|_| Rejected)?;
        self.approval
            .verify(&envelope.signing_data(), &sig)
            .map_err(|_| Rejected)?;
        // Consume before decrypt or dispatch. An ambiguous error must never retry.
        let item = self.pending.remove(&envelope.request_id).ok_or(Rejected)?;
        let peer = PublicKey::from_sec1_bytes(&decode(&envelope.ephemeral_public_key, 65, 65)?)
            .map_err(|_| Rejected)?;
        let sealed = decode(&envelope.ciphertext, 29, 20000)?;
        let shared = diffie_hellman(item.key.to_nonzero_scalar(), peer.as_affine());
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, shared.raw_secret_bytes())
            .expand(envelope.request_id.as_bytes(), &mut *key)
            .map_err(|_| Rejected)?;
        let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| Rejected)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&sealed[..12]), &sealed[12..])
                .map_err(|_| Rejected)?,
        );
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            request_id: String,
            command_digest: String,
            value: String,
        }
        impl Drop for Input {
            fn drop(&mut self) {
                self.value.zeroize();
            }
        }
        let input: Input = serde_json::from_slice(&plaintext).map_err(|_| Rejected)?;
        if input.request_id != item.ticket.request_id
            || input.command_digest != item.ticket.command_digest
            || input.value.is_empty()
            || input.value.len() > 4096
            || input.value.chars().any(char::is_control)
        {
            return Err(Rejected);
        }
        let code = execute(
            &item.ticket.command,
            uid,
            input.value.as_bytes(),
            item.bound,
        );
        Ok(Receipt {
            request_id: envelope.request_id,
            status: if code.is_ok() {
                "completed"
            } else {
                "outcome_unknown"
            },
            exit_code: code.ok().filter(|c| (0..=255).contains(c)),
        })
    }
}
pub fn valid_path(value: &str) -> bool {
    value.starts_with('/') && value.len() <= 4096 && !value.chars().any(char::is_control)
}
/// One complete object, LF, EOF. Absolute deadline is enforced by the caller's
/// poll loop; per-read socket timeouts alone allow slowloris indefinitely.
pub fn read_frame(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_FRAME + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FRAME
        || bytes.last() != Some(&b'\n')
        || bytes[..bytes.len() - 1].contains(&b'\n')
    {
        return Err(io::ErrorKind::InvalidData.into());
    }
    serde_json::from_slice::<Request>(&bytes)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    Ok(bytes)
}
#[derive(Default)]
pub struct Admission {
    windows: HashMap<u32, (Instant, u8)>,
}
impl Admission {
    pub fn admit(&mut self, uid: u32) -> bool {
        let now = Instant::now();
        self.windows.retain(|_, w| w.0 > now);
        // Global cap bounds memory even with many local identities.
        if self.windows.len() >= 256 && !self.windows.contains_key(&uid) {
            return false;
        }
        let window = self
            .windows
            .entry(uid)
            .or_insert((now + Duration::from_secs(60), 0));
        if window.1 >= 24 {
            return false;
        }
        window.1 += 1;
        true
    }
}

#[cfg(target_os = "linux")]
pub mod os;

//! Private native sudo approval. Only validated metadata and ciphertext cross HTTP.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hkdf::Hkdf;
use p256::{
    PublicKey,
    ecdh::EphemeralSecret,
    elliptic_curve::{
        rand_core::{OsRng, RngCore},
        sec1::ToEncodedPoint,
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{ManagedClient, ManagedError};

const MAX_RESPONSE: usize = 64 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_NODES: usize = 256;
const MAX_EXPIRY: u64 = 9_007_199_254_740_991;

/// Safe native approval receipt or explicit request/agent selector. Never contains a secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeSecureInputRequest {
    /// Canonical lowercase UUID of the pending request.
    pub request_id: String,
    /// Exact account-owned agent identifier.
    pub agent_id: String,
    /// Expected machine from a tool receipt; absent only for an explicit selector.
    pub machine_id: Option<String>,
    /// Expected Unix-millisecond expiry; absent only for an explicit selector.
    pub expires_at: Option<u64>,
}

impl NativeSecureInputRequest {
    /// Constructs an explicit selector. Both request and agent are required.
    ///
    /// # Errors
    /// Rejects noncanonical request UUIDs and unsafe agent identifiers.
    pub fn selector(
        request_id: impl Into<String>,
        agent_id: impl Into<String>,
    ) -> Result<Self, ManagedError> {
        let request = Self {
            request_id: request_id.into(),
            agent_id: agent_id.into(),
            machine_id: None,
            expires_at: None,
        };
        request.validate(false)?;
        Ok(request)
    }

    /// Strictly projects a single native receipt through bounded tool envelopes.
    /// Unknown receipt keys, failed envelopes, ambiguity and excessive nesting are rejected.
    pub fn parse(value: &Value) -> Option<Self> {
        let mut nodes = 0;
        let mut found = Vec::new();
        walk(value, 0, &mut nodes, &mut found).ok()?;
        if found.len() == 1 { found.pop() } else { None }
    }

    /// Whether this selector is valid and has not expired, if expiry is known.
    pub fn is_current(&self) -> bool {
        self.validate(true).is_ok()
    }

    fn validate(&self, current: bool) -> Result<(), ManagedError> {
        if !valid_uuid(&self.request_id)
            || !valid_agent(&self.agent_id)
            || self
                .machine_id
                .as_deref()
                .is_some_and(|v| !valid_machine(v))
            || self.machine_id.is_some() != self.expires_at.is_some()
            || self
                .expires_at
                .is_some_and(|v| v == 0 || v > MAX_EXPIRY || (current && v <= now()))
        {
            return Err(invalid());
        }
        Ok(())
    }
}

fn walk(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    found: &mut Vec<NativeSecureInputRequest>,
) -> Result<(), ManagedError> {
    *nodes += 1;
    if depth >= MAX_DEPTH || *nodes > MAX_NODES {
        return Err(invalid());
    }
    match value {
        Value::String(text) if text.len() <= MAX_RESPONSE => {
            if let Ok(decoded) = serde_json::from_str::<Value>(text) {
                walk(&decoded, depth + 1, nodes, found)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                walk(child, depth + 1, nodes, found)?;
            }
        }
        Value::Object(fields) => {
            if fields.get("isError") == Some(&Value::Bool(true))
                || fields.get("success") == Some(&Value::Bool(false))
            {
                return Err(invalid());
            }
            if fields.get("type").and_then(Value::as_str) == Some("secure_input") {
                exact_keys(
                    value,
                    &[
                        "type",
                        "status",
                        "kind",
                        "request_id",
                        "agent_id",
                        "machine_id",
                        "expires_at",
                    ],
                )?;
                if string(value, "status")? != "input_required"
                    || string(value, "kind")? != "native_sudo"
                {
                    return Err(invalid());
                }
                let request = NativeSecureInputRequest {
                    request_id: string(value, "request_id")?.to_owned(),
                    agent_id: string(value, "agent_id")?.to_owned(),
                    machine_id: Some(string(value, "machine_id")?.to_owned()),
                    expires_at: Some(value["expires_at"].as_u64().ok_or_else(invalid)?),
                };
                request.validate(false)?;
                // MCP commonly presents the same receipt in text and structured
                // content. Only exact full-binding duplicates are equivalent;
                // distinct requests and malformed parallel siblings still fail.
                if !found.contains(&request) {
                    found.push(request);
                }
                if found.len() > 1 {
                    return Err(invalid());
                }
            } else {
                for key in [
                    "content",
                    "text",
                    "structuredContent",
                    "structuredResult",
                    "result",
                    "output",
                ] {
                    if let Some(child) = fields.get(key) {
                        walk(child, depth + 1, nodes, found)?;
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Authenticated command description, bound to its request and validated digest.
/// No serialization is available; this is for private local review only.
pub struct NativeSecureInputDescription {
    /// Account UUID supplied only by the authenticated private account route.
    /// It is never taken from model-visible tool output.
    pub account_id: String,
    /// Pending request UUID.
    pub request_id: String,
    /// Enrolled recipient machine.
    pub machine_id: String,
    /// Absolute executable, rendered literally for review.
    pub executable: String,
    /// Exact argument vector, rendered literally for review.
    pub arguments: Vec<String>,
    /// Absolute working directory, rendered literally for review.
    pub cwd: String,
    /// Non-root recipient Unix user ID.
    pub uid: u32,
    /// Unix-millisecond expiry.
    pub expires_at: u64,
    command_digest: String,
    authenticated_account_id: String,
    public_key: PublicKey,
    binding: NativeSecureInputRequest,
}

#[derive(Serialize)]
struct CommandBinding<'a> {
    arguments: &'a [String],
    cwd: &'a str,
    executable: &'a str,
    uid: u32,
}

impl NativeSecureInputDescription {
    /// Canonical base64 SHA-256 binding of the authenticated reviewed command.
    /// This nonsecret value may be shown in the private approval UI.
    pub fn command_digest(&self) -> &str {
        &self.command_digest
    }

    fn parse(
        value: &Value,
        request: &NativeSecureInputRequest,
        account_id: &str,
    ) -> Result<Self, ManagedError> {
        request.validate(true)?;
        if !valid_account_id(account_id) {
            return Err(invalid());
        }
        exact_keys(
            value,
            &[
                "request_id",
                "machine_id",
                "executable",
                "arguments",
                "cwd",
                "uid",
                "command_digest",
                "public_key",
                "expires_at",
            ],
        )?;
        let machine = string(value, "machine_id")?;
        let expiry = value["expires_at"].as_u64().ok_or_else(invalid)?;
        if string(value, "request_id")? != request.request_id
            || !valid_machine(machine)
            || request
                .machine_id
                .as_deref()
                .is_some_and(|expected| expected != machine)
            || request
                .expires_at
                .is_some_and(|expected| expected != expiry)
            || expiry <= now()
            || expiry > now().saturating_add(301_000)
        {
            return Err(invalid());
        }
        let uid = value["uid"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .ok_or_else(invalid)?;
        let executable = string(value, "executable")?.to_owned();
        let cwd = string(value, "cwd")?.to_owned();
        let arguments = value["arguments"]
            .as_array()
            .filter(|a| a.len() <= 128)
            .ok_or_else(invalid)?
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| s.len() <= 4096 && !s.contains('\0'))
                    .map(str::to_owned)
                    .ok_or_else(invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !valid_path(&executable) || !valid_path(&cwd) {
            return Err(invalid());
        }
        let command_digest = string(value, "command_digest")?.to_owned();
        let digest = bytes(&command_digest, 32)?;
        let canonical = serde_json::to_vec(&CommandBinding {
            arguments: &arguments,
            cwd: &cwd,
            executable: &executable,
            uid,
        })
        .map_err(|_| invalid())?;
        if Sha256::digest(&canonical)[..] != digest {
            return Err(invalid());
        }
        let key = bytes(string(value, "public_key")?, 65)?;
        if key[0] != 4 {
            return Err(invalid());
        }
        let public_key = PublicKey::from_sec1_bytes(&key).map_err(|_| invalid())?;
        Ok(Self {
            account_id: account_id.to_owned(),
            authenticated_account_id: account_id.to_owned(),
            request_id: request.request_id.clone(),
            machine_id: machine.to_owned(),
            executable,
            arguments,
            cwd,
            uid,
            expires_at: expiry,
            command_digest,
            public_key,
            binding: NativeSecureInputRequest {
                request_id: request.request_id.clone(),
                agent_id: request.agent_id.clone(),
                machine_id: Some(machine.to_owned()),
                expires_at: Some(expiry),
            },
        })
    }

    /// Encrypts locally using ephemeral P256 ECDH, HKDF-SHA256 and AES-256-GCM.
    /// The borrowed secret is never retained or sent as plaintext. Prefer
    /// [`Self::encrypt_secret`] when ownership and automatic zeroization are available.
    ///
    /// # Errors
    /// Rejects expired/tampered descriptions and empty, oversized or control-containing secrets.
    pub fn encrypt(&self, value: &str) -> Result<NativeSecureInputEnvelope, ManagedError> {
        self.binding.validate(true)?;
        let canonical = serde_json::to_vec(&CommandBinding {
            arguments: &self.arguments,
            cwd: &self.cwd,
            executable: &self.executable,
            uid: self.uid,
        })
        .map_err(|_| invalid())?;
        if self.account_id != self.authenticated_account_id
            || self.request_id != self.binding.request_id
            || Some(self.machine_id.as_str()) != self.binding.machine_id.as_deref()
            || Some(self.expires_at) != self.binding.expires_at
            || self.uid == 0
            || STANDARD.encode(Sha256::digest(&canonical)) != self.command_digest
            || value.is_empty()
            || value.len() > 4096
            || value.chars().any(|c| c < ' ' || c == '\u{7f}')
        {
            return Err(invalid());
        }
        #[derive(Serialize)]
        struct Plaintext<'a> {
            request_id: &'a str,
            command_digest: &'a str,
            value: &'a str,
        }
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&Plaintext {
                request_id: &self.request_id,
                command_digest: &self.command_digest,
                value,
            })
            .map_err(|_| invalid())?,
        );
        let ephemeral = EphemeralSecret::random(&mut OsRng);
        let public_key = PublicKey::from(&ephemeral);
        let shared = ephemeral.diffie_hellman(&self.public_key);
        let mut key = Zeroizing::new([0_u8; 32]);
        Hkdf::<sha2_hkdf::Sha256>::new(Some(&[]), shared.raw_secret_bytes())
            .expand(self.request_id.as_bytes(), key.as_mut())
            .map_err(|_| invalid())?;
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| invalid())?;
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .map_err(|_| invalid())?;
        let mut combined = nonce.to_vec();
        combined.extend_from_slice(&encrypted);
        Ok(NativeSecureInputEnvelope {
            binding: self.binding.clone(),
            ephemeral_public_key: STANDARD.encode(public_key.to_encoded_point(false).as_bytes()),
            ciphertext: STANDARD.encode(combined),
        })
    }

    /// Consumes a zeroizing secret and encrypts it entirely locally.
    ///
    /// # Errors
    /// Returns the same bounded validation failures as [`Self::encrypt`].
    pub fn encrypt_secret(
        &self,
        value: Zeroizing<String>,
    ) -> Result<NativeSecureInputEnvelope, ManagedError> {
        self.encrypt(value.as_str())
    }
}

/// Opaque encrypted approval. Deliberately neither Debug nor Serialize nor Clone.
/// Only the authenticated private client can submit this consumable envelope.
pub struct NativeSecureInputEnvelope {
    binding: NativeSecureInputRequest,
    ephemeral_public_key: String,
    ciphertext: String,
}

/// Fixed native command outcome; no remote command output or free-form error text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeSecureInputStatus {
    /// Command returned zero.
    Completed,
    /// Command returned nonzero.
    Failed,
    /// Dispatch may have occurred; never retry the request.
    OutcomeUnknown,
    /// Pending approval was cancelled.
    Cancelled,
}
impl NativeSecureInputStatus {
    /// Stable protocol status.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Cancelled => "cancelled",
        }
    }
    /// Bounded locally-defined presentation text.
    pub const fn message(self) -> &'static str {
        match self {
            Self::Completed => "Protected command completed successfully.",
            Self::Failed => "Protected command failed. Check the machine before continuing.",
            Self::OutcomeUnknown => {
                "Submission outcome unknown. Check the machine before any further attempt."
            }
            Self::Cancelled => "Secure input cancelled.",
        }
    }
}

/// Safe private submission/cancellation receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeSecureInputReceipt {
    /// Bound pending request UUID.
    pub request_id: String,
    /// Fixed outcome, never remote error text.
    pub status: NativeSecureInputStatus,
}
impl NativeSecureInputReceipt {
    /// Bounded local description of the outcome.
    pub fn message(&self) -> &'static str {
        self.status.message()
    }
    fn parse(
        value: &Value,
        request: &NativeSecureInputRequest,
        cancel: bool,
    ) -> Result<Self, ManagedError> {
        exact_keys(value, &["type", "request_id", "status"])?;
        if string(value, "type")? != "secure_input_receipt"
            || string(value, "request_id")? != request.request_id
        {
            return Err(invalid());
        }
        let status = match string(value, "status")? {
            "completed" if !cancel => NativeSecureInputStatus::Completed,
            "failed" if !cancel => NativeSecureInputStatus::Failed,
            "outcome_unknown" if !cancel => NativeSecureInputStatus::OutcomeUnknown,
            "cancelled" if cancel => NativeSecureInputStatus::Cancelled,
            _ => return Err(invalid()),
        };
        Ok(Self {
            request_id: request.request_id.clone(),
            status,
        })
    }
}

impl ManagedClient {
    /// Fetches and validates private command metadata, not tool-result descriptions.
    ///
    /// # Errors
    /// Rejects expired selectors, malformed bindings, or unsuccessful private HTTP.
    pub async fn describe_native_secure_input(
        &self,
        request: &NativeSecureInputRequest,
    ) -> Result<NativeSecureInputDescription, ManagedError> {
        request.validate(true)?;
        // Read identity through the same immutable bearer/transport policy. Never
        // accept an account label from model-visible receipt metadata.
        let account_id = self.native_secure_input_account_id().await?;
        let value = self
            .native_secure_input_post(
                request,
                json!({"request_id": request.request_id, "action": "describe"}),
            )
            .await?;
        NativeSecureInputDescription::parse(&value, request, &account_id)
    }

    /// Submits ciphertext exactly once. No plaintext or model tool dispatch is used.
    ///
    /// # Errors
    /// Rejects expired/mismatched requests or invalid receipts. Transport errors
    /// may represent dispatch: never retry this private mutation.
    pub async fn submit_native_secure_input(
        &self,
        request: &NativeSecureInputRequest,
        envelope: NativeSecureInputEnvelope,
    ) -> Result<NativeSecureInputReceipt, ManagedError> {
        request.validate(true)?;
        envelope.binding.validate(true)?;
        if request.request_id != envelope.binding.request_id
            || request.agent_id != envelope.binding.agent_id
            || request
                .machine_id
                .as_ref()
                .is_some_and(|v| Some(v) != envelope.binding.machine_id.as_ref())
            || request
                .expires_at
                .is_some_and(|v| Some(v) != envelope.binding.expires_at)
        {
            return Err(invalid());
        }
        let value = self.native_secure_input_post(request, json!({"request_id": envelope.binding.request_id, "ephemeral_public_key": envelope.ephemeral_public_key, "ciphertext": envelope.ciphertext})).await?;
        NativeSecureInputReceipt::parse(&value, request, false)
    }

    /// Cancels exactly once through private authenticated HTTP.
    ///
    /// # Errors
    /// Rejects invalid selectors, failed HTTP, or non-cancellation receipts.
    pub async fn cancel_native_secure_input(
        &self,
        request: &NativeSecureInputRequest,
    ) -> Result<NativeSecureInputReceipt, ManagedError> {
        request.validate(false)?;
        let value = self
            .native_secure_input_post(
                request,
                json!({"request_id": request.request_id, "action": "cancel"}),
            )
            .await?;
        NativeSecureInputReceipt::parse(&value, request, true)
    }

    async fn native_secure_input_account_id(&self) -> Result<String, ManagedError> {
        let value = self
            .native_secure_input_response(
                self.http
                    .get(self.url("v1/me")?)
                    .timeout(Duration::from_secs(30)),
            )
            .await?;
        let account_id = string(&value["user"], "id")?;
        if !valid_account_id(account_id)
            || value["user"]["persistent"] != Value::Bool(true)
            || !matches!(
                string(&value, "authentication")?,
                "api_key" | "account_session"
            )
        {
            return Err(invalid());
        }
        Ok(account_id.to_owned())
    }

    async fn native_secure_input_post(
        &self,
        request: &NativeSecureInputRequest,
        body: Value,
    ) -> Result<Value, ManagedError> {
        let path = format!("v1/agents/{}/native-secure-input", request.agent_id);
        // Do not use send_with_access: even its rejected-access recovery can replay a write.
        // The pool's fixed bearer authorization and redirect-disabled policy still apply.
        self.native_secure_input_response(
            self.http
                .post(self.url(&path)?)
                .timeout(Duration::from_secs(30))
                .json(&body),
        )
        .await
    }

    async fn native_secure_input_response(
        &self,
        mut builder: reqwest::RequestBuilder,
    ) -> Result<Value, ManagedError> {
        if let Some(origin) = &self.request_origin {
            builder = builder.header("x-nanocodex-client-context", origin);
        }
        let mut response = builder.send().await.map_err(|_| invalid())?;
        if !response.status().is_success() {
            return Err(ManagedError::Http {
                status: response.status(),
                code: "native_secure_input_failed".to_owned(),
                message: "Native secure input unavailable".to_owned(),
            });
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_RESPONSE as u64)
        {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                return Err(invalid());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }
}

fn invalid() -> ManagedError {
    ManagedError::InvalidResponse("native secure input unavailable")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(u64::MAX, |v| {
            u64::try_from(v.as_millis()).unwrap_or(u64::MAX)
        })
}
fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.hyphenated().to_string() == value)
}
// Matches account-auth.ts USER_ID: canonical UUIDv4 with RFC4122 variant.
fn valid_account_id(value: &str) -> bool {
    valid_uuid(value)
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
}
fn valid_agent(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn valid_machine(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(|c| c < ' ' || c == '\u{7f}')
}
fn valid_path(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 4096
        && !value.chars().any(|c| c < ' ' || c == '\u{7f}')
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, ManagedError> {
    value[key].as_str().ok_or_else(invalid)
}
fn exact_keys(value: &Value, keys: &[&str]) -> Result<(), ManagedError> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != keys.len() || keys.iter().any(|k| !object.contains_key(*k)) {
        return Err(invalid());
    }
    Ok(())
}
fn bytes(value: &str, length: usize) -> Result<Vec<u8>, ManagedError> {
    if value.len() != length.div_ceil(3) * 4 {
        return Err(invalid());
    }
    let decoded = STANDARD.decode(value).map_err(|_| invalid())?;
    if decoded.len() != length || STANDARD.encode(&decoded) != value {
        return Err(invalid());
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::{get, post},
    };
    use p256::{SecretKey, ecdh::diffie_hellman};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    const ID: &str = "cbbfa5ef-2e4b-45f7-9c98-3913f8ca87cf";
    const ACCOUNT: &str = "a14681d3-6c58-4ff7-9b25-3f56f5a9e8d3";
    const AGENT: &str = "private_agent";
    const MACHINE: &str = "linux-test";
    const PATH: &str = "/v1/agents/private_agent/native-secure-input";

    fn fixture_request() -> NativeSecureInputRequest {
        NativeSecureInputRequest {
            request_id: ID.to_owned(),
            agent_id: AGENT.to_owned(),
            machine_id: Some(MACHINE.to_owned()),
            expires_at: Some(now() + 200_000),
        }
    }
    fn receipt(request: &NativeSecureInputRequest) -> Value {
        json!({"type":"secure_input", "status":"input_required", "kind":"native_sudo", "request_id":request.request_id, "agent_id":request.agent_id, "machine_id":request.machine_id, "expires_at":request.expires_at})
    }
    fn ticket(request: &NativeSecureInputRequest, secret: &SecretKey) -> Value {
        // JS JSON.stringify and Swift sortedKeys+withoutEscapingSlashes agree on
        // this exact canonical byte sequence, including slash, backslash and Unicode.
        let arguments = vec![
            "a/b".to_owned(),
            "quote\"\\雪".to_owned(),
            "line\n".to_owned(),
        ];
        let canonical = br#"{"arguments":["a/b","quote\"\\"#;
        let binding = serde_json::to_vec(&CommandBinding {
            arguments: &arguments,
            cwd: "/home/test",
            executable: "/usr/bin/id",
            uid: 1000,
        })
        .unwrap();
        assert!(binding.starts_with(canonical));
        assert_eq!(
            std::str::from_utf8(&binding).unwrap(),
            "{\"arguments\":[\"a/b\",\"quote\\\"\\\\雪\",\"line\\n\"],\"cwd\":\"/home/test\",\"executable\":\"/usr/bin/id\",\"uid\":1000}"
        );
        json!({"request_id":ID,"machine_id":MACHINE,"executable":"/usr/bin/id","arguments":arguments,"cwd":"/home/test","uid":1000,
            "expires_at":request.expires_at.unwrap(),"command_digest":STANDARD.encode(Sha256::digest(&binding)),"public_key":STANDARD.encode(secret.public_key().to_encoded_point(false).as_bytes())})
    }
    fn description(
        request: &NativeSecureInputRequest,
        secret: &SecretKey,
    ) -> NativeSecureInputDescription {
        NativeSecureInputDescription::parse(&ticket(request, secret), request, ACCOUNT).unwrap()
    }
    fn decrypt(secret: &SecretKey, envelope: &NativeSecureInputEnvelope) -> Value {
        let ephemeral =
            PublicKey::from_sec1_bytes(&STANDARD.decode(&envelope.ephemeral_public_key).unwrap())
                .unwrap();
        let shared = diffie_hellman(secret.to_nonzero_scalar(), ephemeral.as_affine());
        let mut key = Zeroizing::new([0; 32]);
        Hkdf::<sha2_hkdf::Sha256>::new(Some(&[]), shared.raw_secret_bytes())
            .expand(ID.as_bytes(), key.as_mut())
            .unwrap();
        let combined = STANDARD.decode(&envelope.ciphertext).unwrap();
        let plaintext = Zeroizing::new(
            Aes256Gcm::new_from_slice(key.as_ref())
                .unwrap()
                .decrypt(Nonce::from_slice(&combined[..12]), &combined[12..])
                .unwrap(),
        );
        serde_json::from_slice(&plaintext).unwrap()
    }
    async fn client(app: Router) -> (ManagedClient, tokio::task::JoinHandle<()>) {
        client_without_account(app.route(
            "/v1/me",
            get(|headers: HeaderMap| async move {
                assert_auth(&headers);
                Json(json!({"user":{"id":ACCOUNT,"persistent":true},"authentication":"api_key"}))
            }),
        ))
        .await
    }
    async fn client_without_account(app: Router) -> (ManagedClient, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let key =
            crate::ManagedApiKey::parse(format!("ncx_live_{}_{}", "a".repeat(12), "b".repeat(43)))
                .unwrap();
        (
            ManagedClient::new(format!("http://{address}"), key).unwrap(),
            server,
        )
    }
    fn assert_auth(headers: &HeaderMap) {
        assert!(
            headers["authorization"]
                .to_str()
                .unwrap()
                .starts_with("Bearer ncx_live_")
        );
        assert!(!headers.contains_key("idempotency-key"));
        assert!(!headers.contains_key("x-nanocodex-access"));
    }

    #[test]
    fn projects_only_exact_safe_receipts_and_bounded_envelopes() {
        let request = fixture_request();
        let raw = receipt(&request);
        for wrapped in [
            raw.clone(),
            json!({"content":[{"type":"text","text":raw.to_string()}]}),
            json!({"result":{"structuredContent":raw}}),
            json!({"success":true,"structuredResult":raw}),
            json!({"content":[{"type":"text","text":raw.to_string()}],"structuredContent":raw}),
        ] {
            assert_eq!(
                NativeSecureInputRequest::parse(&wrapped),
                Some(request.clone())
            );
        }
        for patch in [
            json!({"value":"never"}),
            json!({"request_id":"../escape"}),
            json!({"request_id":ID.to_uppercase()}),
            json!({"agent_id":".."}),
            json!({"agent_id":"a/b"}),
            json!({"machine_id":"bad\n"}),
            json!({"expires_at":1.5}),
            json!({"expires_at":0}),
            json!({"expires_at":MAX_EXPIRY+1}),
            json!({"kind":"browser_password"}),
            json!({"status":"completed"}),
        ] {
            let mut invalid = receipt(&request);
            invalid
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(NativeSecureInputRequest::parse(&invalid).is_none());
        }
        assert!(
            NativeSecureInputRequest::parse(&json!({"secret":{"structuredContent":raw}})).is_none()
        );
        assert!(NativeSecureInputRequest::parse(&json!({"isError":true,"content":raw})).is_none());
        assert!(NativeSecureInputRequest::parse(&json!({"success":false,"output":raw})).is_none());
        assert_eq!(
            NativeSecureInputRequest::parse(&json!([raw, raw])),
            Some(request.clone())
        );
        for patch in [
            json!({"request_id":"00000000-0000-0000-0000-000000000000"}),
            json!({"agent_id":"other"}),
            json!({"machine_id":"other"}),
            json!({"expires_at":request.expires_at.unwrap()+1}),
            json!({"kind":"browser_password"}),
            json!({"value":"malformed-parallel-sibling"}),
        ] {
            let mut sibling = raw.clone();
            sibling
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(
                NativeSecureInputRequest::parse(&json!({
                    "content":[{"type":"text","text":raw.to_string()}],
                    "structuredContent":sibling
                }))
                .is_none()
            );
        }
        let mut nested = receipt(&request);
        for _ in 0..12 {
            nested = json!({"output":nested});
        }
        assert!(NativeSecureInputRequest::parse(&nested).is_none());
        let mut large = vec![Value::Null; MAX_NODES];
        large.push(receipt(&request));
        assert!(NativeSecureInputRequest::parse(&Value::Array(large)).is_none());
        assert!(NativeSecureInputRequest::selector(ID, "").is_err());
        assert!(NativeSecureInputRequest::selector(ID, AGENT).is_ok());
    }

    #[test]
    fn authentic_description_rejects_changed_bindings_and_noncanonical_crypto() {
        let request = fixture_request();
        let secret = SecretKey::random(&mut OsRng);
        let raw = ticket(&request, &secret);
        for patch in [
            json!({"request_id":"00000000-0000-0000-0000-000000000000"}),
            json!({"machine_id":"other"}),
            json!({"expires_at":request.expires_at.unwrap()+1}),
            json!({"uid":0}),
            json!({"uid":-1}),
            json!({"uid":4294967296_u64}),
            json!({"uid":1.5}),
            json!({"cwd":"relative"}),
            json!({"executable":"/bad\n"}),
            json!({"arguments":["nul\0"]}),
            json!({"command_digest":STANDARD.encode([0;32])}),
            json!({"public_key":STANDARD.encode([4;65])}),
            json!({"extra":"private"}),
        ] {
            let mut altered = raw.clone();
            altered
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(NativeSecureInputDescription::parse(&altered, &request, ACCOUNT).is_err());
        }
        let selector = NativeSecureInputRequest::selector(ID, AGENT).unwrap();
        assert!(NativeSecureInputDescription::parse(&raw, &selector, ACCOUNT).is_ok());
        for account in [
            "not-account-uuid".to_owned(),
            ACCOUNT.to_uppercase(),
            "00000000-0000-0000-0000-000000000000".to_owned(),
            "a14681d3-6c58-1ff7-9b25-3f56f5a9e8d3".to_owned(),
        ] {
            assert!(NativeSecureInputDescription::parse(&raw, &selector, &account).is_err());
        }
        let mut model_account = raw.clone();
        model_account["account_id"] = Value::String(ACCOUNT.to_owned());
        assert!(NativeSecureInputDescription::parse(&model_account, &selector, ACCOUNT).is_err());
        let mut expired = request;
        expired.expires_at = Some(now() - 1);
        assert!(NativeSecureInputDescription::parse(&raw, &expired, ACCOUNT).is_err());
        assert!(bytes("AA==", 1).is_ok());
        assert!(bytes("AB==", 1).is_err());
    }

    #[test]
    fn encrypts_zeroizing_secret_with_protocol_binding_and_fresh_ephemeral_nonce() {
        let request = fixture_request();
        let secret = SecretKey::random(&mut OsRng);
        let mut description = description(&request, &secret);
        assert_eq!(description.account_id, ACCOUNT);
        assert_eq!(
            description.command_digest(),
            ticket(&request, &secret)["command_digest"]
        );
        description.account_id = "00000000-0000-0000-0000-000000000000".to_owned();
        assert!(description.encrypt("never").is_err());
        description.account_id = ACCOUNT.to_owned();
        let envelope = description
            .encrypt_secret(Zeroizing::new("fixture-only-雪".to_owned()))
            .unwrap();
        assert_eq!(
            decrypt(&secret, &envelope),
            json!({"request_id":ID,"command_digest":description.command_digest,"value":"fixture-only-雪"})
        );
        let second = description.encrypt("fixture-only-雪").unwrap();
        assert_ne!(envelope.ephemeral_public_key, second.ephemeral_public_key);
        assert_ne!(
            &STANDARD.decode(&envelope.ciphertext).unwrap()[..12],
            &STANDARD.decode(&second.ciphertext).unwrap()[..12]
        );
        for bad in ["", "a\n", "a\0", "\u{7f}"] {
            assert!(description.encrypt(bad).is_err());
        }
        assert!(description.encrypt(&"x".repeat(4097)).is_err());
        description.arguments.push("tampered".to_owned());
        assert!(description.encrypt("never").is_err());
    }

    #[tokio::test]
    async fn private_account_identity_fails_closed_before_describe_and_never_retries() {
        for (status, response) in [
            (
                StatusCode::UNAUTHORIZED,
                json!({"message":"REMOTE_IDENTITY_BODY"}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"id":ACCOUNT,"persistent":true},"authentication":"connect_grant"}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"id":ACCOUNT,"persistent":false},"authentication":"api_key"}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"id":"bad\nREMOTE_IDENTITY_BODY","persistent":true},"authentication":"api_key"}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"id":ACCOUNT.to_uppercase(),"persistent":true},"authentication":"api_key"}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"persistent":true},"authentication":"api_key"}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"id":ACCOUNT,"persistent":true}}),
            ),
            (
                StatusCode::OK,
                json!({"user":{"id":ACCOUNT,"persistent":true},"authentication":"api_key","padding":"x".repeat(MAX_RESPONSE+1)}),
            ),
        ] {
            let reads = Arc::new(AtomicUsize::new(0));
            let posts = Arc::new(AtomicUsize::new(0));
            let read_count = reads.clone();
            let post_count = posts.clone();
            let app = Router::new()
                .route(
                    "/v1/me",
                    get(move |headers: HeaderMap| {
                        let count = read_count.clone();
                        let response = response.clone();
                        async move {
                            assert_auth(&headers);
                            count.fetch_add(1, Ordering::SeqCst);
                            (
                                status,
                                [("x-nanocodex-access-rejected", "1")],
                                Json(response),
                            )
                        }
                    }),
                )
                .route(
                    PATH,
                    post(move || {
                        let count = post_count.clone();
                        async move {
                            count.fetch_add(1, Ordering::SeqCst);
                            StatusCode::INTERNAL_SERVER_ERROR
                        }
                    }),
                );
            let (client, server) = client_without_account(app).await;
            // Description intentionally has no Debug implementation.
            let error = client
                .describe_native_secure_input(&fixture_request())
                .await
                .err()
                .unwrap();
            assert!(!format!("{error:?} {error}").contains("REMOTE_IDENTITY_BODY"));
            assert_eq!(reads.load(Ordering::SeqCst), 1);
            assert_eq!(posts.load(Ordering::SeqCst), 0);
            server.abort();
        }
    }

    #[tokio::test]
    async fn private_wire_is_authenticated_bound_and_ciphertext_only() {
        let request = fixture_request();
        let secret = Arc::new(SecretKey::random(&mut OsRng));
        let raw = ticket(&request, &secret);
        let expected_digest = raw["command_digest"].clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = Router::new().route(PATH, post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let raw = raw.clone(); let secret = secret.clone(); let expected_digest = expected_digest.clone(); let calls = count.clone();
            async move {
                assert_auth(&headers); calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(body["request_id"], ID);
                let response = match body["action"].as_str() {
                    Some("describe") => { exact_keys(&body, &["request_id", "action"]).unwrap(); raw },
                    Some("cancel") => { exact_keys(&body, &["request_id", "action"]).unwrap(); json!({"type":"secure_input_receipt","request_id":ID,"status":"cancelled"}) },
                    _ => {
                        exact_keys(&body, &["request_id", "ephemeral_public_key", "ciphertext"]).unwrap();
                        assert!(!body.to_string().contains("fixture-only-secret"));
                        let envelope = NativeSecureInputEnvelope { binding: fixture_request(), ephemeral_public_key:body["ephemeral_public_key"].as_str().unwrap().to_owned(), ciphertext:body["ciphertext"].as_str().unwrap().to_owned() };
                        assert_eq!(decrypt(&secret, &envelope), json!({"request_id":ID,"command_digest":expected_digest,"value":"fixture-only-secret"}));
                        json!({"type":"secure_input_receipt","request_id":ID,"status":"completed"})
                    }
                }; Json(response)
            }
        }));
        let (client, server) = client(app).await;
        let description = client.describe_native_secure_input(&request).await.unwrap();
        assert_eq!(description.account_id, ACCOUNT);
        assert_eq!(description.machine_id, MACHINE);
        assert_eq!(description.uid, 1000);
        let envelope = description
            .encrypt_secret(Zeroizing::new("fixture-only-secret".to_owned()))
            .unwrap();
        let receipt = client
            .submit_native_secure_input(&request, envelope)
            .await
            .unwrap();
        assert_eq!(receipt.status, NativeSecureInputStatus::Completed);
        assert!(!format!("{receipt:?}").contains("fixture-only-secret"));
        assert_eq!(
            client
                .cancel_native_secure_input(&request)
                .await
                .unwrap()
                .status,
            NativeSecureInputStatus::Cancelled
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn private_errors_suppress_bodies_and_never_retry_even_access_rejections() {
        let request = fixture_request();
        let secret = SecretKey::random(&mut OsRng);
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = Router::new().route(
            PATH,
            post(move |headers: HeaderMap| {
                let count = count.clone();
                async move {
                    assert_auth(&headers);
                    count.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::UNAUTHORIZED,
                        [("x-nanocodex-access-rejected", "1")],
                        Json(json!({"message":"REMOTE_PASSWORD_BODY","error":"SECRET"})),
                    )
                }
            }),
        );
        let (client, server) = client(app).await;
        let envelope = description(&request, &secret)
            .encrypt("fixture-only")
            .unwrap();
        for error in [
            client
                .submit_native_secure_input(&request, envelope)
                .await
                .unwrap_err(),
            client
                .cancel_native_secure_input(&request)
                .await
                .unwrap_err(),
        ] {
            assert!(!format!("{error:?} {error}").contains("REMOTE_PASSWORD_BODY"));
            assert!(!format!("{error:?} {error}").contains("SECRET"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn response_loss_after_dispatch_never_retries_or_reflects_transport_details() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let request = fixture_request();
        let secret = SecretKey::random(&mut OsRng);
        let envelope = description(&request, &secret)
            .encrypt("fixture-only-response-loss-secret")
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let dispatches = Arc::new(AtomicUsize::new(0));
        let count = dispatches.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut wire = Vec::new();
                // Receive the entire request before simulating a dispatched command
                // whose HTTP response was lost. Keep accepting to expose any replay.
                let body_start = loop {
                    let mut chunk = [0; 1024];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(read, 0);
                    wire.extend_from_slice(&chunk[..read]);
                    if let Some(index) = wire.windows(4).position(|v| v == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let headers = std::str::from_utf8(&wire[..body_start]).unwrap();
                assert!(headers.starts_with(&format!("POST {PATH} HTTP/1.1\r\n")));
                let lower = headers.to_ascii_lowercase();
                assert!(lower.contains("\r\nauthorization: bearer ncx_live_"));
                assert!(!lower.contains("idempotency-key:"));
                assert!(!lower.contains("x-nanocodex-access:"));
                let length: usize = lower
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                while wire.len() - body_start < length {
                    let mut chunk = [0; 1024];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(read, 0);
                    wire.extend_from_slice(&chunk[..read]);
                }
                let body = &wire[body_start..body_start + length];
                assert!(
                    !std::str::from_utf8(body)
                        .unwrap()
                        .contains("fixture-only-response-loss-secret")
                );
                let body: Value = serde_json::from_slice(body).unwrap();
                exact_keys(&body, &["request_id", "ephemeral_public_key", "ciphertext"]).unwrap();
                assert_eq!(body["request_id"], ID);
                let received = NativeSecureInputEnvelope {
                    binding: fixture_request(),
                    ephemeral_public_key: body["ephemeral_public_key"].as_str().unwrap().to_owned(),
                    ciphertext: body["ciphertext"].as_str().unwrap().to_owned(),
                };
                assert_eq!(
                    decrypt(&secret, &received)["value"],
                    "fixture-only-response-loss-secret"
                );
                count.fetch_add(1, Ordering::SeqCst);
                socket.shutdown().await.unwrap();
                // No response bytes are returned after the simulated dispatch.
            }
        });
        let key =
            crate::ManagedApiKey::parse(format!("ncx_live_{}_{}", "a".repeat(12), "b".repeat(43)))
                .unwrap();
        let client = ManagedClient::new(format!("http://{address}"), key).unwrap();
        let error = client
            .submit_native_secure_input(&request, envelope)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ManagedError::InvalidResponse("native secure input unavailable")
        ));
        let rendered = format!("{error:?} {error}");
        assert!(!rendered.contains("fixture-only-response-loss-secret"));
        assert!(!rendered.contains(&address.to_string()));
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_malformed_mismatched_and_oversized_private_receipts() {
        for response in [
            json!({"type":"secure_input_receipt","request_id":ID,"status":"submitted"}),
            json!({"type":"secure_input_receipt","request_id":"other","status":"completed"}),
            json!({"type":"secure_input_receipt","request_id":ID,"status":"completed","output":"never"}),
            json!({"type":"secure_input_receipt","request_id":ID,"status":"cancelled"}),
            json!({"body":"x".repeat(MAX_RESPONSE+1)}),
        ] {
            let app = Router::new().route(
                PATH,
                post(move || {
                    let response = response.clone();
                    async move { Json(response) }
                }),
            );
            let (client, server) = client(app).await;
            let request = fixture_request();
            let secret = SecretKey::random(&mut OsRng);
            let envelope = description(&request, &secret)
                .encrypt("fixture-only")
                .unwrap();
            assert!(
                client
                    .submit_native_secure_input(&request, envelope)
                    .await
                    .is_err()
            );
            server.abort();
        }
        for status in ["completed", "failed", "outcome_unknown"] {
            assert!(
                NativeSecureInputReceipt::parse(
                    &json!({"type":"secure_input_receipt","request_id":ID,"status":status}),
                    &fixture_request(),
                    false
                )
                .is_ok()
            );
            assert!(
                NativeSecureInputReceipt::parse(
                    &json!({"type":"secure_input_receipt","request_id":ID,"status":status}),
                    &fixture_request(),
                    true
                )
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn local_selector_envelope_mismatch_fails_before_http() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = Router::new().route(
            PATH,
            post(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        );
        let (client, server) = client(app).await;
        let request = fixture_request();
        let secret = SecretKey::random(&mut OsRng);
        let mut wrong_agent = request.clone();
        wrong_agent.agent_id = "other".to_owned();
        let mut wrong_request = request.clone();
        wrong_request.request_id = "00000000-0000-0000-0000-000000000000".to_owned();
        let mut wrong_machine = request.clone();
        wrong_machine.machine_id = Some("other".to_owned());
        let mut wrong_expiry = request.clone();
        wrong_expiry.expires_at = Some(request.expires_at.unwrap() + 1);
        for altered in [wrong_agent, wrong_request, wrong_machine, wrong_expiry] {
            let envelope = description(&request, &secret)
                .encrypt("fixture-only")
                .unwrap();
            assert!(
                client
                    .submit_native_secure_input(&altered, envelope)
                    .await
                    .is_err()
            );
        }
        let mut expired = request;
        expired.expires_at = Some(now() - 1);
        assert!(client.describe_native_secure_input(&expired).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.abort();
    }
}

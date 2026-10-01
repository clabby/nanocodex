//! Private, direct-account subscription sign-in; never part of managed prompt input.
use std::{collections::BTreeMap, fmt};

use reqwest::Method;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::{ManagedClient, ManagedError};

/// Single-use private manual authorization completion material.
///
/// Supply only from a private native input, never from a prompt or tool result.
/// The value is not cloneable or serializable, redacts Debug, and zeroizes on drop.
pub struct ClaudeLoginCode(String);

impl ClaudeLoginCode {
    /// Captures the private `code#state` value without reflecting invalid input.
    ///
    /// # Errors
    /// Rejects empty, oversized, or control-character-containing input.
    pub fn parse(value: impl Into<String>) -> Result<Self, ManagedError> {
        let mut value = value.into();
        if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
            value.zeroize();
            return Err(ManagedError::Configuration(
                "invalid private Claude completion input".to_owned(),
            ));
        }
        Ok(Self(value))
    }
}

impl fmt::Debug for ClaudeLoginCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClaudeLoginCode([REDACTED])")
    }
}

impl Drop for ClaudeLoginCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Pending private browser authorization, returned only by an explicit start.
///
/// The authorization URL includes private state and must not enter logs, model
/// input, ordinary account status, or persisted conversation data.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeLogin {
    state: String,
    authorization_url: String,
    /// Expiration time in Unix milliseconds.
    pub expires_at: u64,
}

impl ClaudeLogin {
    /// Destination for an explicitly requested private browser sign-in.
    /// Do not log or send this URL to a model.
    #[must_use]
    pub fn authorization_url(&self) -> &str {
        &self.authorization_url
    }

    fn validate(self) -> Result<Self, ManagedError> {
        let url = Url::parse(&self.authorization_url)
            .map_err(|_| ManagedError::InvalidResponse("invalid Claude sign-in destination"))?;
        let mut query = BTreeMap::new();
        for (name, value) in url.query_pairs() {
            if !matches!(
                name.as_ref(),
                "code"
                    | "client_id"
                    | "response_type"
                    | "redirect_uri"
                    | "scope"
                    | "code_challenge"
                    | "code_challenge_method"
                    | "state"
            ) || query
                .insert(name.into_owned(), value.into_owned())
                .is_some()
            {
                return Err(ManagedError::InvalidResponse(
                    "invalid Claude sign-in destination",
                ));
            }
        }
        let parameter = |name: &str| query.get(name).map(String::as_str).unwrap_or("");
        let scopes: Vec<_> = parameter("scope").split_whitespace().collect();
        let expected_scopes = [
            "org:create_api_key",
            "user:profile",
            "user:inference",
            "user:sessions:claude_code",
            "user:mcp_servers",
            "user:file_upload",
            "user:plugins",
        ];
        // Match the registered native manual flow, not a callback URL carrying
        // an authorization code. `code=true` is its public authorization flag.
        if self.state != "pending"
            || self.expires_at == 0
            || url.scheme() != "https"
            || url.host_str() != Some("claude.com")
            || url.path() != "/cai/oauth/authorize"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
            || query.len() != 8
            || parameter("code") != "true"
            || parameter("client_id") != "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
            || parameter("response_type") != "code"
            || parameter("redirect_uri") != "https://platform.claude.com/oauth/code/callback"
            || parameter("code_challenge_method") != "S256"
            || !base64url_secret(parameter("state"))
            || !base64url_secret(parameter("code_challenge"))
            || scopes.len() != expected_scopes.len()
            || expected_scopes.iter().any(|scope| !scopes.contains(scope))
        {
            return Err(ManagedError::InvalidResponse(
                "invalid Claude sign-in destination",
            ));
        }
        Ok(self)
    }
}

fn base64url_secret(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

impl fmt::Debug for ClaudeLogin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeLogin")
            .field("authorization_url", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl Drop for ClaudeLogin {
    fn drop(&mut self) {
        self.authorization_url.zeroize();
    }
}

/// Public credential state projection; never contains tokens or authorization URLs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClaudeLoginStatus {
    /// No connected subscription or pending authorization.
    SignedOut,
    /// Private authorization awaits manual completion.
    Pending {
        /// Pending authorization expiration in Unix milliseconds.
        expires_at: u64,
    },
    /// Subscription credential expired.
    Expired,
    /// Exchange was attempted and its outcome is not safe to retry.
    ExchangeUncertain,
    /// A completed exchange awaits credential validation.
    Validating,
    /// The provider reports a held account; do not offer a model call.
    AccountOnHold,
    /// A validated subscription credential is connected.
    Authenticated {
        /// Credential expiration in Unix milliseconds.
        expires_at: u64,
        /// Public provider account identity.
        account_id: String,
        /// Public provider organization identity.
        organization_id: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Disconnected {
    connected: bool,
    state: String,
}

impl ManagedClient {
    /// Starts one direct-account Claude subscription authorization.
    ///
    /// Never retries this write. If its outcome is unknown, inspect status
    /// before requesting another authorization. Opening the returned URL and
    /// submitting private input require the user's explicit authorization.
    ///
    /// # Errors
    /// Returns only sanitized failures, never provider payloads or private state.
    pub async fn claude_login_start(&self) -> Result<ClaudeLogin, ManagedError> {
        let login: ClaudeLogin = self
            .claude_auth_json(Method::POST, "v1/credentials/claude/login", None)
            .await?;
        login.validate()
    }

    /// Reads the public credential state without returning private OAuth state.
    ///
    /// # Errors
    /// Returns a sanitized transport, HTTP, or schema failure.
    pub async fn claude_login_status(&self) -> Result<ClaudeLoginStatus, ManagedError> {
        self.claude_auth_json(Method::GET, "v1/credentials/claude/login", None)
            .await
    }

    /// Completes one authorization using private manual `code#state` input.
    ///
    /// Consumes the redacted value and never retries the write, including on a
    /// lost response. The server also fences attempted exchanges. On failure,
    /// inspect [`Self::claude_login_status`] rather than replaying the code.
    /// Direct account authority is required; Connect grants are rejected by
    /// the server. This method must not be called from agent/model tool input.
    ///
    /// # Errors
    /// Returns only sanitized failures; request and provider material are never reflected.
    pub async fn claude_login_complete(
        &self,
        code: ClaudeLoginCode,
    ) -> Result<ClaudeLoginStatus, ManagedError> {
        #[derive(Serialize)]
        struct Completion<'a> {
            code: &'a str,
        }
        let body = Zeroizing::new(serde_json::to_vec(&Completion { code: &code.0 }).map_err(
            |_| ManagedError::InvalidResponse("failed to encode private Claude completion"),
        )?);
        self.claude_auth_json(
            Method::POST,
            "v1/credentials/claude/login/complete",
            Some(&body),
        )
        .await
    }

    /// Disconnects the subscription credential after explicit user authorization.
    ///
    /// Never retries the write. Read status after an unknown outcome.
    ///
    /// # Errors
    /// Returns only sanitized failures or an invalid disconnect receipt.
    pub async fn claude_disconnect(&self) -> Result<ClaudeLoginStatus, ManagedError> {
        let receipt: Disconnected = self
            .claude_auth_json(Method::DELETE, "v1/credentials/claude", None)
            .await?;
        if receipt.connected || receipt.state != "signed_out" {
            return Err(ManagedError::InvalidResponse(
                "invalid Claude disconnect receipt",
            ));
        }
        Ok(ClaudeLoginStatus::SignedOut)
    }

    async fn claude_auth_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<T, ManagedError> {
        // This route is ineligible for access-cache replay and performs exactly
        // one request. Do not use the ordinary JSON error decoder: even a faulty
        // server must not reflect private completion material into Debug/errors.
        let response = self.request(method, path, body, None).await.map_err(|_| {
            ManagedError::InvalidResponse(
                "Claude authentication outcome unknown; inspect status before retrying",
            )
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(ManagedError::Http {
                status,
                code: "claude_auth_failed".to_owned(),
                message: "Claude authentication request failed; inspect credential status before retrying".to_owned(),
            });
        }
        let mut bytes = response
            .bytes()
            .await
            .map_err(|_| {
                ManagedError::InvalidResponse(
                    "Claude authentication outcome unknown; inspect status before retrying",
                )
            })?
            .to_vec();
        let result = serde_json::from_slice(&bytes)
            .map_err(|_| ManagedError::InvalidResponse("invalid Claude authentication response"));
        bytes.zeroize();
        result
    }
}

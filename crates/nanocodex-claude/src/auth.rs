//! Host-owned bearer authentication for documented API token sources or an
//! explicitly approved integration contract. This module supplies no Anthropic
//! subscription OAuth endpoints, client identity, login flow, or credential store.
use std::{sync::Arc, time::Duration};

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use tokio::sync::Mutex;
use web_time::SystemTime;

use crate::{ClaudeAuthFuture, ClaudeAuthProvider, ClaudeAuthUnavailable};

/// A short-lived access token returned by a host-controlled credential broker.
/// Deliberately neither serializable nor Debug: credentials stay out of sessions
/// and traces. The host owns persistence of any refresh credentials.
pub struct ClaudeAccessToken {
    authorization: HeaderValue,
    expires_at: SystemTime,
}

impl ClaudeAccessToken {
    pub fn new(
        token: impl AsRef<str>,
        expires_at: SystemTime,
    ) -> Result<Self, ClaudeAuthUnavailable> {
        let token = token.as_ref();
        if token.is_empty()
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(&byte))
        {
            return Err(ClaudeAuthUnavailable);
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| ClaudeAuthUnavailable)?;
        authorization.set_sensitive(true);
        Ok(Self {
            authorization,
            expires_at,
        })
    }

    fn usable(&self, refresh_margin: Duration) -> bool {
        self.expires_at
            .duration_since(SystemTime::now())
            .is_ok_and(|remaining| remaining > refresh_margin)
    }

    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, self.authorization.clone());
        headers
    }
}

/// The explicit host authentication contract. Implement using an authorized API
/// token source (for example Workload Identity Federation), or your approved
/// program's documented exchange. No CLI credential discovery is performed.
///
/// `refresh` must acquire a usable replacement, not return a previously rejected
/// cached token. The host must enforce account identity, securely persist rotated
/// refresh credentials before returning, and coordinate across processes if the
/// credential is shared. It also owns timeouts, backoff, and terminal revocation.
/// Calls may be cancelled; token exchange/persistence must be cancellation-safe.
pub trait ClaudeTokenSource: Send + Sync {
    fn refresh(&self) -> ClaudeAuthFuture<'_, Result<ClaudeAccessToken, ClaudeAuthUnavailable>>;
}

/// Caches bearer tokens until their refresh margin and serializes refreshes within
/// this shared instance. Reuse one Arc across clients for a single host identity.
/// The margin must be smaller than the token lifetime; unusable replacements fail
/// closed. Neither credentials nor this cache belong in durable agent history.
pub struct RefreshingClaudeAuth {
    source: Arc<dyn ClaudeTokenSource>,
    refresh_margin: Duration,
    token: Mutex<Option<ClaudeAccessToken>>,
}

impl RefreshingClaudeAuth {
    pub fn new(source: Arc<dyn ClaudeTokenSource>, refresh_margin: Duration) -> Self {
        Self {
            source,
            refresh_margin,
            token: Mutex::new(None),
        }
    }
}

impl ClaudeAuthProvider for RefreshingClaudeAuth {
    fn headers(&self) -> ClaudeAuthFuture<'_, Result<HeaderMap, ClaudeAuthUnavailable>> {
        Box::pin(async move {
            let mut cached = self.token.lock().await;
            if let Some(token) = cached
                .as_ref()
                .filter(|token| token.usable(self.refresh_margin))
            {
                return Ok(token.headers());
            }
            // Drop expired credentials before awaiting a possibly failed refresh.
            *cached = None;
            let token = self.source.refresh().await?;
            if !token.usable(self.refresh_margin) {
                return Err(ClaudeAuthUnavailable);
            }
            let headers = token.headers();
            *cached = Some(token);
            Ok(headers)
        })
    }

    fn recover_unauthorized<'a>(
        &'a self,
        rejected: &'a HeaderMap,
    ) -> ClaudeAuthFuture<'a, Result<bool, ClaudeAuthUnavailable>> {
        Box::pin(async move {
            let mut cached = self.token.lock().await;
            // A late response from an older request must not discard a token that
            // another request already refreshed. The next headers() call performs
            // at most one serialized refresh for the rejected credential.
            if cached
                .as_ref()
                .is_some_and(|token| rejected.get(AUTHORIZATION) == Some(&token.authorization))
            {
                *cached = None;
            }
            Ok(true)
        })
    }
}

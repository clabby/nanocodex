//! Account-owned, revocable Hand sharing links.
use crate::{ManagedClient, ManagedError};
use reqwest::{Method, Response};
use serde::{Deserialize, Serialize};

/// Creation receipt. The bearer URL is intentionally omitted from Debug.
#[derive(Deserialize, Serialize)]
pub struct CreatedHandShare {
    /// Opaque ID used to revoke the share.
    pub id: String,
    /// Bearer URL to give to a signed-in recipient.
    pub url: String,
}
impl std::fmt::Debug for CreatedHandShare {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedHandShare")
            .field("id", &self.id)
            .field("url", &"[REDACTED]")
            .finish()
    }
}
/// Safe share metadata returned by listing the owner's links.
#[derive(Debug, Deserialize, Serialize)]
pub struct HandShare {
    /// Opaque revocation ID.
    pub id: String,
    /// Shared machine identifier.
    pub machine_id: String,
    /// Creation time as Unix milliseconds.
    pub created_at: u64,
    /// Revocation time as Unix milliseconds, or null while active.
    pub revoked_at: Option<u64>,
}
/// List of active shares owned by the signed-in account.
#[derive(Debug, Deserialize, Serialize)]
pub struct HandShares {
    /// Active link metadata without bearer URLs.
    pub data: Vec<HandShare>,
}
/// Receipt confirming a machine was added to the recipient's account.
#[derive(Debug, Deserialize, Serialize)]
pub struct RedeemedHandShare {
    /// Shared machine identifier for subsequent Hand operations.
    pub machine_id: String,
}
fn invalid() -> ManagedError {
    ManagedError::InvalidResponse("invalid Hand share response; reconcile writes before retrying")
}
impl ManagedClient {
    async fn hand_share_request(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<Response, ManagedError> {
        let bytes = body
            .map(|body| serde_json::to_vec(&body))
            .transpose()
            .map_err(|_| invalid())?;
        let response = self
            .request(method, path, bytes.as_deref(), None)
            .await
            .map_err(|_| {
                ManagedError::InvalidResponse(
                    "Hand share transport failed; reconcile writes before retrying",
                )
            })?;
        if !response.status().is_success() {
            return Err(ManagedError::Http { status: response.status(), code: "hand_share_request_failed".into(), message: "Hand share request failed; check account access and reconcile uncertain writes before retrying".into() });
        }
        Ok(response)
    }
    /// Creates a link once. Never automatically retry after an uncertain result.
    pub async fn create_hand_share(
        &self,
        machine_id: &str,
    ) -> Result<CreatedHandShare, ManagedError> {
        self.hand_share_request(
            Method::POST,
            "v1/account/hand-shares",
            Some(serde_json::json!({"machine_id": machine_id})),
        )
        .await?
        .json()
        .await
        .map_err(|_| invalid())
    }
    /// Lists the owner's active links without bearer URLs.
    pub async fn list_hand_shares(&self) -> Result<HandShares, ManagedError> {
        self.hand_share_request(Method::GET, "v1/account/hand-shares", None)
            .await?
            .json()
            .await
            .map_err(|_| invalid())
    }
    /// Revokes one link and its recipient access. Sends exactly one request.
    pub async fn revoke_hand_share(&self, id: &str) -> Result<(), ManagedError> {
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(ManagedError::Configuration("invalid Hand share ID".into()));
        }
        let receipt: serde_json::Value = self
            .hand_share_request(
                Method::DELETE,
                &format!("v1/account/hand-shares/{id}"),
                None,
            )
            .await?
            .json()
            .await
            .map_err(|_| invalid())?;
        if receipt.get("revoked") != Some(&serde_json::Value::Bool(true)) {
            return Err(invalid());
        }
        Ok(())
    }
    /// Redeems a bearer URL with the current signed-in account.
    /// The URL is sent only to the configured managed service, never fetched.
    pub async fn redeem_hand_share(&self, url: &str) -> Result<RedeemedHandShare, ManagedError> {
        self.hand_share_request(
            Method::POST,
            "v1/account/hand-shares/redeem",
            Some(serde_json::json!({"url": url})),
        )
        .await?
        .json()
        .await
        .map_err(|_| invalid())
    }
}

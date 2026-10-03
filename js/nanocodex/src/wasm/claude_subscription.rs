//! Private host capabilities for the Rust-owned Claude subscription lifecycle.
//! No OAuth state or credential is copied to agent session/checkpoint state.
use super::{JsFuture, JsValue, js_error};
use nanocodex_claude::subscription::{
    ClaudeLoginMode, ClaudeSubscription, ClaudeSubscriptionCommit, ClaudeSubscriptionConfig,
    ClaudeSubscriptionHost, ClaudeSubscriptionHostError, ClaudeSubscriptionHttpRequest,
    ClaudeSubscriptionHttpResponse, ClaudeSubscriptionStoreValue,
};
use nanocodex_claude::{ClaudeAuthFuture, ClaudeAuthProvider};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexClaudeSubscriptionHost"], js_name = claudeSubscriptionLoad)]
    fn host_load(id: &str) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexClaudeSubscriptionHost"], js_name = claudeSubscriptionCompareAndSwap)]
    fn host_cas(id: &str, revision: &str, payload: &str) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexClaudeSubscriptionHost"], js_name = claudeSubscriptionRequest)]
    fn host_request(id: &str, request: &str) -> Result<js_sys::Promise, JsValue>;
}
struct JavaScriptHost {
    id: String,
}
#[derive(Deserialize)]
struct Stored {
    revision: String,
    payload: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Commit {
    Committed { revision: String },
    Conflict { actual_revision: String },
}
#[derive(Deserialize)]
struct Response {
    status: u16,
    body: String,
}
async fn decode<T: serde::de::DeserializeOwned>(
    promise: Result<js_sys::Promise, JsValue>,
) -> Result<T, ClaudeSubscriptionHostError> {
    let value = JsFuture::from(promise.map_err(|_| ClaudeSubscriptionHostError)?)
        .await
        .map_err(|_| ClaudeSubscriptionHostError)?;
    serde_json::from_str(&value.as_string().ok_or(ClaudeSubscriptionHostError)?)
        .map_err(|_| ClaudeSubscriptionHostError)
}
fn revision(value: &str) -> Result<u64, ClaudeSubscriptionHostError> {
    value.parse().map_err(|_| ClaudeSubscriptionHostError)
}
impl ClaudeSubscriptionHost for JavaScriptHost {
    fn load<'a>(
        &'a self,
        key: &'a str,
    ) -> ClaudeAuthFuture<'a, Result<ClaudeSubscriptionStoreValue, ClaudeSubscriptionHostError>>
    {
        Box::pin(async move {
            if key != self.id {
                return Err(ClaudeSubscriptionHostError);
            }
            let stored: Stored = decode(host_load(key)).await?;
            Ok(ClaudeSubscriptionStoreValue {
                revision: revision(&stored.revision)?,
                payload: stored.payload,
            })
        })
    }
    fn compare_and_swap<'a>(
        &'a self,
        key: &'a str,
        expected: u64,
        payload: &'a str,
    ) -> ClaudeAuthFuture<'a, Result<ClaudeSubscriptionCommit, ClaudeSubscriptionHostError>> {
        Box::pin(async move {
            if key != self.id {
                return Err(ClaudeSubscriptionHostError);
            }
            match decode::<Commit>(host_cas(key, &expected.to_string(), payload)).await? {
                Commit::Committed { revision: value } => {
                    Ok(ClaudeSubscriptionCommit::Committed(revision(&value)?))
                }
                Commit::Conflict { actual_revision } => Ok(ClaudeSubscriptionCommit::Conflict(
                    revision(&actual_revision)?,
                )),
            }
        })
    }
    fn request(
        &self,
        request: ClaudeSubscriptionHttpRequest,
    ) -> ClaudeAuthFuture<'_, Result<ClaudeSubscriptionHttpResponse, ClaudeSubscriptionHostError>>
    {
        Box::pin(async move {
            let headers = header_values(request.headers())?;
            let encoded = serde_json::json!({ "method": request.method(), "url": request.url(), "headers": headers,
                "body": request.body(), "maxResponseBytes": request.max_response_bytes(), "timeoutMillis": request.timeout_millis() }).to_string();
            let response: Response = decode(host_request(&self.id, &encoded)).await?;
            Ok(ClaudeSubscriptionHttpResponse {
                status: response.status,
                body: response.body,
            })
        })
    }
}
fn header_values(
    headers: &reqwest::header::HeaderMap,
) -> Result<BTreeMap<String, String>, ClaudeSubscriptionHostError> {
    headers
        .iter()
        .map(|(key, value)| {
            Ok((
                key.to_string(),
                value
                    .to_str()
                    .map_err(|_| ClaudeSubscriptionHostError)?
                    .to_owned(),
            ))
        })
        .collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    id: String,
}
#[derive(Serialize)]
struct Credential {
    kind: &'static str,
    headers: BTreeMap<String, String>,
    revision: String,
}
/// Host-only lifecycle handle. Authorization URL/status are the only browser-safe results.
#[wasm_bindgen(js_name = ClaudeSubscription)]
pub struct WasmClaudeSubscription {
    inner: ClaudeSubscription,
    id: String,
}
#[wasm_bindgen(js_class = ClaudeSubscription)]
impl WasmClaudeSubscription {
    pub async fn open(encoded: &str) -> Result<Self, JsValue> {
        let config: Config = serde_json::from_str(encoded)
            .map_err(|_| js_error("invalid Claude subscription configuration"))?;
        let inner = ClaudeSubscription::new(
            Arc::new(JavaScriptHost {
                id: config.id.clone(),
            }),
            config.id.clone(),
            ClaudeSubscriptionConfig::default(),
        )
        .map_err(js_error)?;
        Ok(Self {
            inner,
            id: config.id,
        })
    }
    #[wasm_bindgen(js_name = startLogin)]
    pub async fn start_login(&self) -> Result<String, JsValue> {
        serde_json::to_string(
            &self
                .inner
                .begin_login(ClaudeLoginMode::Manual)
                .await
                .map_err(js_error)?,
        )
        .map_err(|_| js_error("Claude login unavailable"))
    }
    #[wasm_bindgen(js_name = completeLogin)]
    pub async fn complete_login(&self, private_code: &str) -> Result<String, JsValue> {
        serde_json::to_string(
            &self
                .inner
                .complete_login(private_code)
                .await
                .map_err(js_error)?,
        )
        .map_err(|_| js_error("Claude login unavailable"))
    }
    pub async fn status(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.status().await.map_err(js_error)?)
            .map_err(|_| js_error("Claude status unavailable"))
    }
    /// Private capability: never expose through account API, tool result, or trace.
    pub async fn credential(&self) -> Result<String, JsValue> {
        let headers = self
            .inner
            .headers()
            .await
            .map_err(|_| js_error("Claude login required"))?;
        let stored: Stored = decode(host_load(&self.id))
            .await
            .map_err(|_| js_error("Claude host unavailable"))?;
        serde_json::to_string(&Credential {
            kind: "claude",
            headers: header_values(&headers).map_err(|_| js_error("Claude host unavailable"))?,
            revision: stored.revision,
        })
        .map_err(|_| js_error("Claude host unavailable"))
    }
    /// Invalidate only the rejected credential; next credential() performs bounded refresh.
    pub async fn recover(&self, encoded: &str) -> Result<bool, JsValue> {
        let input: BTreeMap<String, String> =
            serde_json::from_str(encoded).map_err(|_| js_error("invalid Claude recovery"))?;
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in input {
            let key = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| js_error("invalid Claude recovery"))?;
            let value = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| js_error("invalid Claude recovery"))?;
            headers.insert(key, value);
        }
        self.inner
            .recover_unauthorized(&headers)
            .await
            .map_err(|_| js_error("Claude recovery unavailable"))
    }
    pub async fn logout(&self) -> Result<(), JsValue> {
        self.inner.logout().await.map_err(js_error)
    }
}

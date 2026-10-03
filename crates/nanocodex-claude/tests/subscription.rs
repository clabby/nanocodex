//! Public OAuth protocol journeys and durability failure injection. Synthetic
//! credentials only; all requests pass through the same host capability as prod.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nanocodex_claude::{ClaudeAuthFuture, ClaudeAuthProvider, subscription::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use url::Url;

struct Step {
    method: &'static str,
    result: std::result::Result<ClaudeSubscriptionHttpResponse, ClaudeSubscriptionHostError>,
    pause: Option<Arc<Pause>>,
}
#[derive(Default)]
struct Pause {
    entered: Notify,
    release: Notify,
}
#[derive(Default)]
struct Host {
    store: Mutex<ClaudeSubscriptionStoreValue>,
    steps: Mutex<VecDeque<Step>>,
    requests: Mutex<Vec<(String, String, reqwest::header::HeaderMap, Value)>>,
    conflicts: Mutex<usize>,
    fail_save_kind: Mutex<Option<String>>,
    fail_after_commit_kind: Mutex<Option<String>>,
}
impl Host {
    fn response(&self, method: &'static str, status: u16, body: Value) {
        self.steps.lock().unwrap().push_back(Step {
            method,
            result: Ok(ClaudeSubscriptionHttpResponse {
                status,
                body: body.to_string(),
            }),
            pause: None,
        });
    }
    fn token(&self, access: &str, refresh: &str) {
        self.response("POST", 200, token(access, refresh));
    }
    fn profile(&self, account: &str, organization: &str) {
        self.response(
            "GET",
            200,
            json!({"account":{"uuid":account},"organization":{"uuid":organization}}),
        );
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    fn pause_next(&self) -> Arc<Pause> {
        let pause = Arc::new(Pause::default());
        self.steps.lock().unwrap().front_mut().unwrap().pause = Some(pause.clone());
        pause
    }
}
impl ClaudeSubscriptionHost for Host {
    fn load<'a>(
        &'a self,
        _: &'a str,
    ) -> ClaudeAuthFuture<
        'a,
        std::result::Result<ClaudeSubscriptionStoreValue, ClaudeSubscriptionHostError>,
    > {
        Box::pin(async { Ok(self.store.lock().unwrap().clone()) })
    }
    fn compare_and_swap<'a>(
        &'a self,
        _: &'a str,
        expected: u64,
        payload: &'a str,
    ) -> ClaudeAuthFuture<
        'a,
        std::result::Result<ClaudeSubscriptionCommit, ClaudeSubscriptionHostError>,
    > {
        Box::pin(async move {
            let value: Value = serde_json::from_str(payload).unwrap();
            let mut fail = self.fail_save_kind.lock().unwrap();
            if fail.as_deref() == value["state"]["kind"].as_str() {
                *fail = None;
                return Err(ClaudeSubscriptionHostError);
            }
            let mut store = self.store.lock().unwrap();
            let mut conflicts = self.conflicts.lock().unwrap();
            if *conflicts > 0 {
                *conflicts -= 1;
                return Ok(ClaudeSubscriptionCommit::Conflict(store.revision));
            }
            if store.revision != expected {
                return Ok(ClaudeSubscriptionCommit::Conflict(store.revision));
            }
            store.revision += 1;
            store.payload = Some(payload.into());
            let mut fail_after = self.fail_after_commit_kind.lock().unwrap();
            if fail_after.as_deref() == value["state"]["kind"].as_str() {
                *fail_after = None;
                return Err(ClaudeSubscriptionHostError);
            }
            Ok(ClaudeSubscriptionCommit::Committed(store.revision))
        })
    }
    fn request(
        &self,
        request: ClaudeSubscriptionHttpRequest,
    ) -> ClaudeAuthFuture<
        '_,
        std::result::Result<ClaudeSubscriptionHttpResponse, ClaudeSubscriptionHostError>,
    > {
        Box::pin(async move {
            assert_eq!(request.max_response_bytes(), 65536);
            let expected_deadline = if request.method() == "GET" {
                10_000
            } else if request.url().ends_with("/revoke") {
                5_000
            } else {
                30_000
            };
            assert_eq!(request.timeout_millis(), expected_deadline);
            let debug = format!("{request:?}");
            assert!(!debug.contains("synthetic") && !debug.contains("PRIVATE"));
            let body = if request.body().is_empty() {
                Value::Null
            } else {
                serde_json::from_str(request.body()).unwrap()
            };
            self.requests.lock().unwrap().push((
                request.method().into(),
                request.url().into(),
                request.headers().clone(),
                body,
            ));
            let step = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected HTTP request/replayed POST");
            assert_eq!(request.method(), step.method);
            if let Ok(response) = &step.result {
                let debug = format!("{response:?}");
                assert!(!debug.contains("synthetic") && !debug.contains("PRIVATE"));
            }
            if let Some(pause) = step.pause {
                pause.entered.notify_one();
                pause.release.notified().await;
            }
            step.result
        })
    }
}
fn token(access: &str, refresh: &str) -> Value {
    json!({"access_token":access,"refresh_token":refresh,"expires_in":3600,"scope":"user:profile user:inference user:sessions:claude_code","token_type":"Bearer"})
}
fn manager(host: &Arc<Host>) -> ClaudeSubscription {
    ClaudeSubscription::new(
        host.clone(),
        "synthetic-account",
        ClaudeSubscriptionConfig::default(),
    )
    .unwrap()
}
fn state(login: &ClaudeLogin) -> String {
    Url::parse(&login.authorization_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned()
}
async fn login(host: &Arc<Host>, manager: &ClaudeSubscription) {
    let pending = manager.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    host.token("synthetic-access-1", "synthetic-refresh-1");
    host.profile("account-a", "org-a");
    manager
        .complete_login(&format!("synthetic-code#{}", state(&pending)))
        .await
        .unwrap();
}

#[tokio::test]
async fn pkce_callback_restart_and_redacted_host_boundary() {
    let host = Arc::new(Host::default());
    let first = manager(&host);
    let login = first
        .begin_login(ClaudeLoginMode::Callback {
            redirect_uri: "http://localhost:34567/callback".into(),
        })
        .await
        .unwrap();
    let url = Url::parse(&login.authorization_url).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(query["client_id"], "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(state(&login).len(), 43);
    let reopened = manager(&host);
    for invalid in [
        "http://evil.test/callback?code=x&state=".to_owned() + &state(&login),
        "http://localhost:34567/callback?code=x&state=wrong".into(),
        "http://localhost:34567/other?code=x&state=".to_owned() + &state(&login),
    ] {
        assert!(reopened.complete_login(&invalid).await.is_err());
    }
    assert_eq!(host.count(), 0);
    host.token("synthetic-access-1", "synthetic-refresh-1");
    host.profile("account-a", "org-a");
    reopened
        .complete_login(&format!(
            "http://localhost:34567/callback?code=synthetic-code&state={}",
            state(&login)
        ))
        .await
        .unwrap();
    let requests = host.requests.lock().unwrap().clone();
    let verifier = requests[0].3["code_verifier"].as_str().unwrap().to_owned();
    assert_eq!(
        query["code_challenge"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    );
    assert_eq!(verifier.len(), 43);
    assert_ne!(verifier, state(&login));
    assert_eq!(requests[0].1, "https://platform.claude.com/v1/oauth/token");
    assert_eq!(requests[0].3["state"], state(&login));
    assert!(!requests[0].2.contains_key("anthropic-beta"));
    assert!(!requests[1].2.contains_key("anthropic-beta"));
    drop(requests);
    let headers = reopened.headers().await.unwrap();
    assert_eq!(headers["anthropic-beta"], "oauth-2025-04-20");
    assert!(headers["authorization"].is_sensitive());
    let debug = format!("{first:?} {login:?} {:?}", host.store.lock().unwrap());
    for secret in [
        "synthetic-access-1",
        "synthetic-refresh-1",
        verifier.to_owned().as_str(),
        state(&login).as_str(),
    ] {
        assert!(!debug.contains(secret));
    }
}

#[tokio::test]
async fn rotated_credentials_restart_later_turn_401_and_late_rejection() {
    let host = Arc::new(Host::default());
    let first = manager(&host);
    login(&host, &first).await;
    let old = first.headers().await.unwrap();
    assert!(first.recover_unauthorized(&old).await.unwrap());
    assert!(first.recover_unauthorized(&old).await.unwrap()); // same failed generation
    host.token("synthetic-access-2", "synthetic-refresh-2");
    host.profile("account-a", "org-a");
    let reopened = manager(&host);
    let new = reopened.headers().await.unwrap();
    assert_eq!(new["authorization"], "Bearer synthetic-access-2");
    assert!(reopened.recover_unauthorized(&old).await.unwrap());
    assert_eq!(
        reopened.headers().await.unwrap()["authorization"],
        new["authorization"]
    );
    // A later turn can reject the next generation; the Messages client bounds
    // recovery per request, rather than imposing a lifetime refresh limit.
    assert!(reopened.recover_unauthorized(&new).await.unwrap());
    host.token("synthetic-access-3", "synthetic-refresh-3");
    host.profile("account-a", "org-a");
    assert_eq!(
        reopened.headers().await.unwrap()["authorization"],
        "Bearer synthetic-access-3"
    );
    assert_eq!(host.count(), 6);
    assert_eq!(
        host.requests.lock().unwrap()[2].3["refresh_token"],
        "synthetic-refresh-1"
    );
    assert_eq!(
        host.requests.lock().unwrap()[4].3["refresh_token"],
        "synthetic-refresh-2"
    );
}

#[tokio::test]
async fn uncertain_post_and_cancellation_survive_restart_without_replay() {
    for cancel in [false, true] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        host.steps.lock().unwrap().push_back(Step {
            method: "POST",
            result: Err(ClaudeSubscriptionHostError),
            pause: None,
        });
        let code = format!("synthetic-code#{}", state(&pending));
        if cancel {
            let pause = host.pause_next();
            let task = tokio::spawn(async move { first.complete_login(&code).await });
            pause.entered.notified().await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert_eq!(
                first.complete_login(&code).await.unwrap_err(),
                ClaudeSubscriptionError::Host
            );
        }
        let reopened = manager(&host);
        assert_eq!(
            reopened.status().await.unwrap(),
            ClaudeSubscriptionStatus::ExchangeUncertain
        );
        assert!(
            reopened
                .complete_login("synthetic-code#anything")
                .await
                .is_err()
        );
        assert!(reopened.headers().await.is_err());
        assert_eq!(host.count(), 1);
        reopened.logout().await.unwrap();
    }
}

#[tokio::test]
async fn refresh_concurrency_and_logout_fence_late_success() {
    let host = Arc::new(Host::default());
    let first = manager(&host);
    login(&host, &first).await;
    let old = first.headers().await.unwrap();
    first.recover_unauthorized(&old).await.unwrap();
    host.token("synthetic-access-2", "synthetic-refresh-2");
    let pause = host.pause_next();
    let task = tokio::spawn(async move { first.headers().await });
    pause.entered.notified().await;
    let concurrent = manager(&host);
    assert!(concurrent.headers().await.is_err());
    assert_eq!(host.count(), 3);
    concurrent.logout().await.unwrap();
    pause.release.notify_one();
    assert!(task.await.unwrap().is_err());
    assert_eq!(
        concurrent.status().await.unwrap(),
        ClaudeSubscriptionStatus::SignedOut
    );
    assert_eq!(host.count(), 3);
}

#[tokio::test]
async fn store_failure_before_or_after_post_is_fail_closed_and_not_replayed() {
    for kind in ["Exchanging", "Validating"] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        *host.fail_save_kind.lock().unwrap() = Some(kind.into());
        host.token("synthetic-access-1", "synthetic-refresh-1");
        let code = format!("synthetic-code#{}", state(&pending));
        assert!(first.complete_login(&code).await.is_err());
        if kind == "Exchanging" {
            assert_eq!(host.count(), 0);
        } else {
            assert_eq!(
                manager(&host).status().await.unwrap(),
                ClaudeSubscriptionStatus::ExchangeUncertain
            );
            assert!(manager(&host).complete_login(&code).await.is_err());
            assert_eq!(host.count(), 1);
        }
    }
    let host = Arc::new(Host::default());
    *host.conflicts.lock().unwrap() = 100;
    assert_eq!(
        manager(&host)
            .begin_login(ClaudeLoginMode::Manual)
            .await
            .unwrap_err(),
        ClaudeSubscriptionError::Conflict
    );
    assert_eq!(host.count(), 0);
}

#[tokio::test]
async fn staged_rotation_recovers_profile_get_after_restart() {
    let host = Arc::new(Host::default());
    let first = manager(&host);
    let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    host.token("synthetic-access-1", "synthetic-refresh-1");
    host.steps.lock().unwrap().push_back(Step {
        method: "GET",
        result: Err(ClaudeSubscriptionHostError),
        pause: None,
    });
    assert!(
        first
            .complete_login(&format!("synthetic-code#{}", state(&pending)))
            .await
            .is_err()
    );
    assert_eq!(
        manager(&host).status().await.unwrap(),
        ClaudeSubscriptionStatus::Validating
    );
    host.profile("account-a", "org-a");
    assert!(manager(&host).headers().await.is_ok());
    assert_eq!(host.count(), 3);
}

#[tokio::test]
async fn identity_continuity_scope_loss_and_provider_errors_do_not_leak() {
    for (account, org) in [("account-b", "org-a"), ("account-a", "org-b")] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        login(&host, &first).await;
        first
            .recover_unauthorized(&first.headers().await.unwrap())
            .await
            .unwrap();
        host.token("synthetic-access-2", "synthetic-refresh-2");
        host.profile(account, org);
        assert!(first.headers().await.is_err());
        assert_eq!(
            first.status().await.unwrap(),
            ClaudeSubscriptionStatus::SignedOut
        );
    }
    for status in [200, 401, 500] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        let mut response = token("PRIVATE-ACCESS", "PRIVATE-REFRESH");
        response["scope"] = json!("user:profile");
        host.response("POST", status, response);
        let error = first
            .complete_login(&format!("synthetic-code#{}", state(&pending)))
            .await
            .unwrap_err();
        assert!(!format!("{error:?} {error}").contains("PRIVATE"));
        assert!(first.headers().await.is_err());
        assert_eq!(host.count(), 1);
    }
}

#[tokio::test]
async fn expired_login_invalid_endpoints_and_refresh_margin() {
    let host = Arc::new(Host::default());
    let mut config = ClaudeSubscriptionConfig {
        login_ttl_millis: 1,
        ..Default::default()
    };
    let first = ClaudeSubscription::new(host.clone(), "test", config.clone()).unwrap();
    let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(
        first.status().await.unwrap(),
        ClaudeSubscriptionStatus::Expired
    );
    assert!(
        first
            .complete_login(&format!("synthetic-code#{}", state(&pending)))
            .await
            .is_err()
    );
    assert_eq!(host.count(), 0);
    config.token_url = "http://provider.example/token".into();
    config.allow_loopback_http = true;
    assert!(ClaudeSubscription::new(host.clone(), "test", config.clone()).is_err());
    config.token_url = "http://127.0.0.1:1234/token".into();
    assert!(ClaudeSubscription::new(host.clone(), "test", config).is_ok());

    let host = Arc::new(Host::default());
    let config = ClaudeSubscriptionConfig {
        refresh_margin_millis: 500,
        ..Default::default()
    };
    let first = ClaudeSubscription::new(host.clone(), "test", config).unwrap();
    let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    let mut short = token("synthetic-access-1", "synthetic-refresh-1");
    short["expires_in"] = json!(1);
    host.response("POST", 200, short);
    host.profile("account-a", "org-a");
    first
        .complete_login(&format!("synthetic-code#{}", state(&pending)))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(550)).await;
    host.token("synthetic-access-2", "synthetic-refresh-2");
    host.profile("account-a", "org-a");
    assert_eq!(
        first.headers().await.unwrap()["authorization"],
        "Bearer synthetic-access-2"
    );
}

#[tokio::test]
async fn definitive_scope_retry_refresh_expiry_and_logout_revocation() {
    let custom_host = Arc::new(Host::default());
    let custom = ClaudeSubscription::new(
        custom_host.clone(),
        "custom",
        ClaudeSubscriptionConfig {
            client_id: "synthetic-custom-registration".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let pending = custom.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    let granted_scopes = "org:create_api_key user:profile user:inference custom:grant";
    let mut response = token("synthetic-access-1", "synthetic-refresh-1");
    response["scope"] = json!(granted_scopes);
    custom_host.response("POST", 200, response);
    custom_host.profile("account-a", "org-a");
    custom
        .complete_login(&format!("code#{}", state(&pending)))
        .await
        .unwrap();
    custom
        .recover_unauthorized(&custom.headers().await.unwrap())
        .await
        .unwrap();
    custom_host.token("synthetic-access-2", "synthetic-refresh-2");
    custom_host.profile("account-a", "org-a");
    assert_eq!(
        custom.headers().await.unwrap()["authorization"],
        "Bearer synthetic-access-2"
    );
    assert_eq!(custom_host.count(), 4);
    assert_eq!(
        custom_host.requests.lock().unwrap()[2].3["scope"],
        granted_scopes
    );
    assert_eq!(
        custom_host.requests.lock().unwrap()[2].3["client_id"],
        "synthetic-custom-registration"
    );

    let host = Arc::new(Host::default());
    let first = manager(&host);
    login(&host, &first).await;
    first
        .recover_unauthorized(&first.headers().await.unwrap())
        .await
        .unwrap();
    host.response("POST", 400, json!({"error":{"type":"invalid_scope"}}));
    let mut rotated = token("synthetic-access-2", "unused");
    rotated.as_object_mut().unwrap().remove("refresh_token");
    host.response("POST", 200, rotated);
    host.profile("account-a", "org-a");
    assert_eq!(
        first.headers().await.unwrap()["authorization"],
        "Bearer synthetic-access-2"
    );
    let requests = host.requests.lock().unwrap().clone();
    assert!(
        !requests[2].3["scope"]
            .as_str()
            .unwrap()
            .contains("org:create_api_key")
    );
    assert_eq!(
        requests[3].3["scope"],
        "user:profile user:inference user:sessions:claude_code"
    );
    drop(requests);
    host.response("POST", 503, json!({"secret":"must-not-escape"}));
    first.logout().await.unwrap();
    assert_eq!(
        first.status().await.unwrap(),
        ClaudeSubscriptionStatus::SignedOut
    );
    let requests = host.requests.lock().unwrap().clone();
    assert_eq!(
        requests.last().unwrap().1,
        "https://platform.claude.com/v1/oauth/token/revoke"
    );
    assert_eq!(requests.last().unwrap().3["token"], "synthetic-refresh-1");
    drop(requests);

    let host = Arc::new(Host::default());
    let first = manager(&host);
    let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    let mut expired = token("synthetic-access-1", "synthetic-refresh-1");
    expired["refresh_token_expires_in"] = json!(0);
    host.response("POST", 200, expired);
    host.profile("account-a", "org-a");
    first
        .complete_login(&format!("code#{}", state(&pending)))
        .await
        .unwrap();
    first
        .recover_unauthorized(&first.headers().await.unwrap())
        .await
        .unwrap();
    assert!(first.headers().await.is_err());
    assert_eq!(host.count(), 2);
    assert_eq!(
        first.status().await.unwrap(),
        ClaudeSubscriptionStatus::SignedOut
    );
}

#[tokio::test]
async fn account_hold_is_distinct_from_invalid_grant_and_response_bound() {
    for hold in [false, true] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        let body = if hold {
            json!({"error":"invalid_grant","error_description":"account_on_hold","error_uri":"PRIVATE-URL"})
        } else {
            json!({"error":{"type":"invalid_grant"}})
        };
        host.response("POST", 401, body);
        let error = first
            .complete_login(&format!("code#{}", state(&pending)))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            if hold {
                ClaudeSubscriptionError::AccountOnHold
            } else {
                ClaudeSubscriptionError::LoginRequired
            }
        );
        assert_eq!(
            first.status().await.unwrap(),
            if hold {
                ClaudeSubscriptionStatus::AccountOnHold
            } else {
                ClaudeSubscriptionStatus::SignedOut
            }
        );
        assert!(!error.to_string().contains("PRIVATE"));
    }
    let host = Arc::new(Host::default());
    let first = manager(&host);
    let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    host.response("POST", 200, json!({"overlong":"S".repeat(65536)}));
    assert_eq!(
        first
            .complete_login(&format!("code#{}", state(&pending)))
            .await
            .unwrap_err(),
        ClaudeSubscriptionError::Invalid
    );
    assert!(manager(&host).headers().await.is_err());
    assert_eq!(host.count(), 1);
}

#[tokio::test]
async fn uncertain_commit_acknowledgements_and_refresh_cancellation_are_recoverable() {
    for kind in ["Exchanging", "Validating"] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        *host.fail_after_commit_kind.lock().unwrap() = Some(kind.into());
        if kind == "Validating" {
            host.token("synthetic-access-1", "synthetic-refresh-1");
        }
        assert!(
            first
                .complete_login(&format!("code#{}", state(&pending)))
                .await
                .is_err()
        );
        let reopened = manager(&host);
        if kind == "Exchanging" {
            assert_eq!(
                reopened.status().await.unwrap(),
                ClaudeSubscriptionStatus::ExchangeUncertain
            );
            assert!(reopened.headers().await.is_err());
            assert_eq!(host.count(), 0);
        } else {
            assert_eq!(
                reopened.status().await.unwrap(),
                ClaudeSubscriptionStatus::Validating
            );
            host.profile("account-a", "org-a");
            assert!(reopened.headers().await.is_ok());
            assert_eq!(host.count(), 2);
        }
    }
    let host = Arc::new(Host::default());
    let first = manager(&host);
    login(&host, &first).await;
    first
        .recover_unauthorized(&first.headers().await.unwrap())
        .await
        .unwrap();
    host.token("synthetic-access-2", "synthetic-refresh-2");
    let pause = host.pause_next();
    let task = tokio::spawn(async move { first.headers().await });
    pause.entered.notified().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(
        manager(&host).status().await.unwrap(),
        ClaudeSubscriptionStatus::ExchangeUncertain
    );
    assert!(manager(&host).headers().await.is_err());
    assert_eq!(host.count(), 3);
}

#[tokio::test]
async fn refresh_invalid_grant_fences_old_credentials_and_profile_identity_is_checked() {
    let host = Arc::new(Host::default());
    let first = manager(&host);
    login(&host, &first).await;
    first
        .recover_unauthorized(&first.headers().await.unwrap())
        .await
        .unwrap();
    host.response("POST", 401, json!({"error":"invalid_grant"}));
    assert!(first.headers().await.is_err());
    assert_eq!(
        manager(&host).status().await.unwrap(),
        ClaudeSubscriptionStatus::SignedOut
    );
    assert!(manager(&host).headers().await.is_err());
    assert_eq!(host.count(), 3);

    let host = Arc::new(Host::default());
    let first = manager(&host);
    let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
    let mut response = token("synthetic-access-1", "synthetic-refresh-1");
    response["account"] = json!({"uuid":"account-other"});
    host.response("POST", 200, response);
    host.profile("account-a", "org-a");
    assert_eq!(
        first
            .complete_login(&format!("code#{}", state(&pending)))
            .await
            .unwrap_err(),
        ClaudeSubscriptionError::Invalid
    );
    assert_eq!(
        first.status().await.unwrap(),
        ClaudeSubscriptionStatus::SignedOut
    );
    assert!(first.headers().await.is_err());
}

#[tokio::test]
async fn same_manager_late_401_waits_for_ongoing_refresh() {
    let host = Arc::new(Host::default());
    let first = manager(&host);
    login(&host, &first).await;
    let old = first.headers().await.unwrap();
    first.recover_unauthorized(&old).await.unwrap();
    host.token("synthetic-access-2", "synthetic-refresh-2");
    let pause = host.pause_next();
    host.profile("account-a", "org-a");
    let refreshing = first.clone();
    let refresh = tokio::spawn(async move { refreshing.headers().await });
    pause.entered.notified().await;
    let started = Arc::new(Notify::new());
    let signal = started.clone();
    let late = tokio::spawn(async move {
        signal.notify_one();
        first.recover_unauthorized(&old).await
    });
    started.notified().await;
    tokio::task::yield_now().await;
    assert!(
        !late.is_finished(),
        "late rejection must await the existing refresh"
    );
    pause.release.notify_one();
    assert_eq!(
        refresh.await.unwrap().unwrap()["authorization"],
        "Bearer synthetic-access-2"
    );
    assert!(late.await.unwrap().unwrap());
    assert_eq!(host.count(), 4);
}

#[tokio::test]
async fn expired_staged_credentials_refresh_after_restart_and_keep_identity_assertions() {
    for profile_account in ["account-a", "account-other"] {
        let host = Arc::new(Host::default());
        let config = ClaudeSubscriptionConfig {
            refresh_margin_millis: 100,
            ..Default::default()
        };
        let first = ClaudeSubscription::new(host.clone(), "test", config.clone()).unwrap();
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        let mut initial = token("synthetic-access-1", "synthetic-refresh-1");
        initial["expires_in"] = json!(1);
        initial["account"] = json!({"uuid":"account-a"});
        initial["organization"] = json!({"uuid":"org-a"});
        host.response("POST", 200, initial);
        host.response("GET", 503, json!({"error":"transient"}));
        assert!(
            first
                .complete_login(&format!("code#{}", state(&pending)))
                .await
                .is_err()
        );
        tokio::time::sleep(Duration::from_millis(1050)).await;
        let reopened = ClaudeSubscription::new(host.clone(), "test", config).unwrap();
        host.token("synthetic-access-2", "synthetic-refresh-2");
        host.profile(profile_account, "org-a");
        let result = reopened.headers().await;
        if profile_account == "account-a" {
            assert_eq!(
                result.unwrap()["authorization"],
                "Bearer synthetic-access-2"
            );
        } else {
            assert!(result.is_err());
            assert_eq!(
                reopened.status().await.unwrap(),
                ClaudeSubscriptionStatus::SignedOut
            );
        }
        assert_eq!(host.count(), 4);
        assert_eq!(
            host.requests.lock().unwrap()[2].3["refresh_token"],
            "synthetic-refresh-1"
        );
    }
}

#[tokio::test]
async fn profile_rejection_preserves_staged_refresh_credentials() {
    for status in [401, 403] {
        let host = Arc::new(Host::default());
        let first = manager(&host);
        let pending = first.begin_login(ClaudeLoginMode::Manual).await.unwrap();
        host.token("synthetic-access-1", "synthetic-refresh-1");
        host.response("GET", status, json!({"error":"profile unavailable"}));
        assert!(
            first
                .complete_login(&format!("code#{}", state(&pending)))
                .await
                .is_err()
        );
        assert_eq!(
            first.status().await.unwrap(),
            ClaudeSubscriptionStatus::Validating
        );
        if status == 401 {
            host.token("synthetic-access-2", "synthetic-refresh-2");
        }
        host.profile("account-a", "org-a");
        assert!(manager(&host).headers().await.is_ok());
        assert_eq!(host.count(), if status == 401 { 4 } else { 3 });
    }
}

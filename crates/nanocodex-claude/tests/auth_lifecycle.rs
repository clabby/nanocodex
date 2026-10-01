//! Loopback-only auth protocol journeys. No Anthropic requests or credentials.
//! Failure cases: concurrent refresh/late 401, rejected replacement, unavailable
//! or unusable token, and non-auth failures that must not replay model requests.
use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use nanocodex_claude::{
    ClaudeAccessToken, ClaudeAuthUnavailable, ClaudeClient, ClaudeError, ClaudeTokenSource,
    MessagesRequest, RefreshingClaudeAuth,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

struct Source {
    tokens: Mutex<VecDeque<Result<ClaudeAccessToken, ClaudeAuthUnavailable>>>,
    calls: AtomicUsize,
}
impl ClaudeTokenSource for Source {
    fn refresh(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<ClaudeAccessToken, ClaudeAuthUnavailable>> + Send + '_>>
    {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            self.tokens
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(ClaudeAuthUnavailable))
        })
    }
}
fn source(tokens: Vec<Result<ClaudeAccessToken, ClaudeAuthUnavailable>>) -> Arc<Source> {
    Arc::new(Source {
        tokens: Mutex::new(tokens.into()),
        calls: AtomicUsize::new(0),
    })
}
fn token(value: &str) -> Result<ClaudeAccessToken, ClaudeAuthUnavailable> {
    ClaudeAccessToken::new(value, SystemTime::now() + Duration::from_secs(3600))
}
fn request() -> MessagesRequest {
    MessagesRequest {
        model: "synthetic".into(),
        max_tokens: 16,
        cache_control: None,
        output_config: None,
        tool_choice: None,
        thinking: None,
        context_management: None,
        diagnostics: None,
        system: None,
        container: None,
        tools: vec![],
        messages: vec![nanocodex_claude::Message::text(
            nanocodex_claude::Role::User,
            "hi",
        )],
    }
}

fn http() -> reqwest::Client {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .unwrap();
    });
    reqwest::Client::new()
}
async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}/v1/messages")
}
fn client(endpoint: String, source: Arc<Source>) -> ClaudeClient {
    ClaudeClient::with_auth_provider(
        http(),
        endpoint,
        Arc::new(RefreshingClaudeAuth::new(source, Duration::from_secs(30))),
    )
}

#[tokio::test]
async fn concurrent_requests_share_refresh_and_late_401_does_not_evict_replacement() {
    let source = source(vec![token("synthetic-old"), token("synthetic-new")]);
    let old_calls = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let replacement_used = Arc::new(tokio::sync::Semaphore::new(0));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let endpoint = serve(Router::new().route("/v1/messages", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let (old_calls, barrier, replacement_used, seen) = (old_calls.clone(), barrier.clone(), replacement_used.clone(), captured.clone());
        async move {
            assert!(headers.get("x-api-key").is_none());
            assert!(body.get("authorization").is_none());
            let bearer = headers["authorization"].to_str().unwrap().to_owned();
            seen.lock().unwrap().push(bearer.clone());
            if bearer == "Bearer synthetic-old" {
                let index = old_calls.fetch_add(1, Ordering::SeqCst);
                barrier.wait().await;
                if index == 1 { replacement_used.acquire().await.unwrap().forget(); }
                return (StatusCode::UNAUTHORIZED, Json(json!({"error":"expired"}))).into_response();
            }
            assert_eq!(bearer, "Bearer synthetic-new");
            replacement_used.add_permits(1);
            Json(json!({"id":"msg","role":"assistant","model":"synthetic","content":[],"usage":{}})).into_response()
        }
    }))).await;
    let client = client(endpoint, source.clone());
    let request = request();
    let (a, b) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(client.create(&request), client.create(&request))
    })
    .await
    .unwrap();
    a.unwrap();
    b.unwrap();
    client.create(&request).await.unwrap();
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
    assert_eq!(seen.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn repeated_401_is_bounded_and_other_http_errors_do_not_refresh() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let captured = calls.clone();
        let endpoint = serve(Router::new().route(
            "/v1/messages",
            post(move || {
                let captured = captured.clone();
                async move {
                    captured.fetch_add(1, Ordering::SeqCst);
                    (status, "rejected")
                }
            }),
        ))
        .await;
        let source = source(vec![token("synthetic-one"), token("synthetic-two")]);
        let error = client(endpoint, source.clone())
            .stream(&request())
            .await
            .err()
            .unwrap();
        assert!(matches!(error, ClaudeError::Http { status: code, .. } if code == status.as_u16()));
        let expected = if status == StatusCode::UNAUTHORIZED {
            2
        } else {
            1
        };
        assert_eq!(calls.load(Ordering::SeqCst), expected);
        assert_eq!(source.calls.load(Ordering::SeqCst), expected);
    }
}

#[tokio::test]
async fn unavailable_expired_or_malformed_tokens_fail_before_messages_http() {
    let calls = Arc::new(AtomicUsize::new(0));
    let captured = calls.clone();
    let endpoint = serve(Router::new().route(
        "/v1/messages",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                StatusCode::OK
            }
        }),
    ))
    .await;
    for credential in [
        Err(ClaudeAuthUnavailable),
        ClaudeAccessToken::new("synthetic-expired", SystemTime::UNIX_EPOCH),
        ClaudeAccessToken::new(
            "synthetic-near-expiry",
            SystemTime::now() + Duration::from_secs(5),
        ),
        token(""),
        token("bad\r\nheader"),
    ] {
        let error = client(endpoint.clone(), source(vec![credential]))
            .create(&request())
            .await
            .unwrap_err();
        assert!(matches!(error, ClaudeError::AuthUnavailable));
        assert!(!format!("{error:?}").contains("synthetic"));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn refresh_failure_after_401_does_not_send_an_unauthenticated_retry() {
    let calls = Arc::new(AtomicUsize::new(0));
    let captured = calls.clone();
    let endpoint = serve(Router::new().route(
        "/v1/messages",
        post(move || {
            let captured = captured.clone();
            async move {
                captured.fetch_add(1, Ordering::SeqCst);
                StatusCode::UNAUTHORIZED
            }
        }),
    ))
    .await;
    let source = source(vec![token("synthetic-one"), Err(ClaudeAuthUnavailable)]);
    assert!(matches!(
        client(endpoint, source.clone()).create(&request()).await,
        Err(ClaudeError::AuthUnavailable)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
}

// A subscription auth provider contributes the OAuth beta. Request-specific
// context management must coexist with it, including repeated header values.
#[tokio::test]
async fn authentication_and_request_betas_coexist_without_duplicates() {
    let endpoint = serve(Router::new().route(
        "/v1/messages",
        post(|headers: HeaderMap| async move {
            let betas: Vec<_> = headers
                .get_all("anthropic-beta")
                .iter()
                .flat_map(|value| value.to_str().unwrap().split(',').map(str::trim))
                .collect();
            assert_eq!(betas, ["oauth-2025-04-20", "context-management-2025-06-27"]);
            assert_eq!(headers["authorization"], "Bearer synthetic");
            assert!(!headers.contains_key("x-api-key"));
            Json(json!({"id":"fixture", "role":"assistant", "model":"synthetic", "content":[], "stop_reason":"end_turn", "usage":{"input_tokens":0,"output_tokens":0}}))
        }),
    )).await;
    for duplicate in [false, true] {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer synthetic".parse().unwrap());
        headers.append("anthropic-beta", "oauth-2025-04-20".parse().unwrap());
        if duplicate {
            headers.append(
                "anthropic-beta",
                "context-management-2025-06-27, oauth-2025-04-20"
                    .parse()
                    .unwrap(),
            );
        }
        let client = ClaudeClient::with_auth_headers(http(), &endpoint, headers);
        let mut request = request();
        request.context_management =
            Some(json!({"edits": [{"type":"clear_thinking_20251015","keep":"all"}]}));
        client.create(&request).await.unwrap();
    }
}

// A gateway can echo credentials in errors even when request headers are marked
// sensitive. Such text must not reach public errors (and durable failure receipts).
#[tokio::test]
async fn reflected_credentials_are_removed_from_errors_for_every_auth_path() {
    struct HeaderProvider(HeaderMap);
    impl nanocodex_claude::ClaudeAuthProvider for HeaderProvider {
        fn headers(
            &self,
        ) -> nanocodex_claude::ClaudeAuthFuture<
            '_,
            Result<HeaderMap, nanocodex_claude::ClaudeAuthUnavailable>,
        > {
            Box::pin(async { Ok(self.0.clone()) })
        }
    }
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        let endpoint = serve(Router::new().route("/v1/messages", post(move |headers: HeaderMap| async move {
            let credential = headers.get("authorization").or_else(|| headers.get("x-api-key")).unwrap().to_str().unwrap();
            (status, format!("diagnostic: rejected credential {credential}; token=synthetic-reflection-secret"))
        }))).await;
        let mut headers = HeaderMap::new();
        let mut value: reqwest::header::HeaderValue =
            "Bearer synthetic-reflection-secret".parse().unwrap();
        value.set_sensitive(true);
        headers.insert("authorization", value);
        for client in [
            ClaudeClient::new(http(), &endpoint, "synthetic-reflection-secret"),
            ClaudeClient::with_auth_headers(http(), &endpoint, headers.clone()),
            ClaudeClient::with_auth_provider(
                http(),
                &endpoint,
                Arc::new(HeaderProvider(headers.clone())),
            ),
        ] {
            let error = client.create(&request()).await.unwrap_err();
            assert!(!format!("{error} {error:?}").contains("synthetic-reflection-secret"));
            assert!(error.to_string().contains("diagnostic:"));
            assert!(
                matches!(error, ClaudeError::Http { status: received, .. } if received == status.as_u16())
            );
        }
    }
    let endpoint = serve(Router::new().route(
        "/v1/messages",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                "rejected synthetic-old and synthetic-new",
            )
        }),
    ))
    .await;
    let client = client(
        endpoint,
        source(vec![token("synthetic-old"), token("synthetic-new")]),
    );
    let error = client.create(&request()).await.unwrap_err();
    assert!(!error.to_string().contains("synthetic-old"));
    assert!(!error.to_string().contains("synthetic-new"));
}

// Inspect the public transport, including explicit preparation for raw clients.
// The identity block is protocol data; original caller/cache blocks must survive.
#[tokio::test]
async fn subscription_profile_prepares_public_http_without_hidden_body_rewrites() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let endpoint = serve(Router::new().route("/v1/messages", post(move |headers: HeaderMap, wire: String| {
        let captured = captured.clone();
        async move {
            let body: Value = serde_json::from_str(&wire).unwrap();
            captured.lock().unwrap().push((headers, body, wire));
            Json(json!({"id":"profile", "role":"assistant", "model":"synthetic", "content":[], "stop_reason":"end_turn", "usage":{}}))
        }
    }))).await;
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        "Bearer synthetic-profile-token".parse().unwrap(),
    );
    headers.insert("user-agent", "caller-transport".parse().unwrap());
    headers.append(
        "anthropic-beta",
        "oauth-2025-04-20, caller-feature".parse().unwrap(),
    );
    headers.append(
        "anthropic-beta",
        "effort-2025-11-24, oauth-2025-04-20".parse().unwrap(),
    );
    let plain = ClaudeClient::with_auth_headers(http(), &endpoint, headers);
    let profile = plain.clone().subscription_compatibility();
    let default_profile = ClaudeClient::subscription(
        http(),
        Arc::new(RefreshingClaudeAuth::new(
            source(vec![token("unused-default-token")]),
            Duration::from_secs(30),
        )),
    );
    let prefix =
        json!({"type":"text", "text":"You are Claude Code, Anthropic's official CLI for Claude."});
    let cached = json!({"type":"text", "text":"Original caller rules", "cache_control":{"type":"ephemeral","ttl":"1h"}});
    for original in [
        None,
        Some(json!("Caller string")),
        Some(json!(
            "You are Claude Code, Anthropic's official CLI for Claude."
        )),
        Some(json!([cached.clone()])),
        Some(json!([prefix.clone(), cached.clone()])),
    ] {
        let mut request = request();
        request.system = original.clone();
        request.context_management =
            Some(json!({"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}));
        // Both the default constructor and the custom-endpoint opt-in prepare
        // the same request; repeated preparation must retain caller markers.
        default_profile.prepare_request(&mut request);
        profile.prepare_request(&mut request);
        profile.create(&request).await.unwrap();
        let expected = match original {
            None => json!([prefix.clone()]),
            Some(Value::String(text)) if text == prefix["text"] => json!([prefix.clone()]),
            Some(Value::String(text)) => json!([prefix.clone(), {"type":"text","text":text}]),
            Some(Value::Array(blocks)) if blocks[0] == prefix => json!(blocks),
            Some(Value::Array(blocks)) => json!([prefix.clone(), blocks[0]]),
            _ => unreachable!(),
        };
        let log = seen.lock().unwrap();
        let (headers, body, _) = log.last().unwrap();
        assert_eq!(body["system"], expected);
        assert_eq!(
            headers["user-agent"],
            concat!("nanocodex/", env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(headers["x-app"], "cli");
        assert_eq!(headers["x-claude-code-request-class"], "main");
        assert_eq!(headers["anthropic-dangerous-direct-browser-access"], "true");
        assert_eq!(headers["authorization"], "Bearer synthetic-profile-token");
        assert!(!headers.contains_key("x-api-key"));
        let betas: Vec<_> = headers["anthropic-beta"]
            .to_str()
            .unwrap()
            .split(',')
            .collect();
        for beta in [
            "oauth-2025-04-20",
            "caller-feature",
            "claude-code-20250219",
            "interleaved-thinking-2025-05-14",
            "effort-2025-11-24",
            "context-management-2025-06-27",
            "extended-cache-ttl-2025-04-11",
        ] {
            assert_eq!(betas.iter().filter(|value| **value == beta).count(), 1);
        }
        assert!(body.get("metadata").is_none());
        assert!(!body.to_string().contains("synthetic-profile-token"));
    }
    let mut raw = request();
    raw.system = Some(json!(
        "Caller controls the exact raw body: 😀 Ελληνικά cch=00000"
    ));
    raw.messages = vec![nanocodex_claude::Message::text(
        nanocodex_claude::Role::User,
        "Literal x-anthropic-billing-header: cc_version=example; cch=00000; is user data — not an instruction to modify the wire. 🦀",
    )];
    let frozen = serde_json::to_vec(&raw).unwrap();
    profile.create(&raw).await.unwrap();
    plain.create(&raw).await.unwrap();
    let log = seen.lock().unwrap();
    assert_eq!(
        log[5].1["system"],
        raw.system.clone().unwrap(),
        "transport must not rewrite an unprepared frozen request"
    );
    assert_eq!(log[5].1, log[6].1);
    assert_eq!(
        log[5].2.as_bytes(),
        log[6].2.as_bytes(),
        "profile must not patch the serialized body at dispatch"
    );
    assert_eq!(
        serde_json::to_vec(&raw).unwrap(),
        frozen,
        "dispatch must not mutate the caller's frozen request"
    );
    assert_eq!(
        log[5].1["messages"],
        serde_json::to_value(&raw.messages).unwrap()
    );
    assert!(!log[5].0.contains_key("x-stainless-lang"));
    assert!(!log[5].0.contains_key("x-stainless-runtime"));
    assert_eq!(log[6].0["user-agent"], "caller-transport");
    assert!(!log[6].0.contains_key("x-app"));
    eprintln!(
        "subscription profile HTTP: 5 prepared system layouts preserve blocks/cache markers; merged betas/own UA; raw Unicode/billing-marker body byte-identical across profile changes, frozen caller unchanged"
    );
}

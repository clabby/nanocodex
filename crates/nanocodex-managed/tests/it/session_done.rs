use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::put,
};
use nanocodex_managed::{ManagedApiKey, ManagedClient, ManagedError, SessionDoneState};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn done_client_uses_authenticated_put_and_decodes_undo_and_failures() {
    let calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    async fn endpoint(
        State(calls): State<Arc<Mutex<Vec<(String, Value)>>>>,
        Path(id): Path<String>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        assert_eq!(
            headers["authorization"],
            format!("Bearer ncx_live_aaaaaaaaaaaa_{}", "a".repeat(43))
        );
        assert_eq!(headers["content-type"], "application/json");
        calls.lock().unwrap().push((id.clone(), body.clone()));
        if id == "forbidden-session" {
            return Err(StatusCode::FORBIDDEN);
        }
        if id == "malformed-session" {
            return Ok(Json(json!({"done_at":null})));
        }
        assert_eq!(id, "synthetic-session");
        assert!(body["done"].is_boolean());
        Ok(Json(
            json!({"done":body["done"],"done_at":if body["done"]==true {Some(1234)} else {None}, "presentation_revision":7}),
        ))
    }
    let app = Router::new()
        .route("/v1/agents/{id}/done", put(endpoint))
        .with_state(calls.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = ManagedClient::new(
        format!("http://{address}"),
        ManagedApiKey::parse(format!("ncx_live_aaaaaaaaaaaa_{}", "a".repeat(43))).unwrap(),
    )
    .unwrap();
    let done: SessionDoneState = client.set_done("synthetic-session", true).await.unwrap();
    assert_eq!(
        done,
        SessionDoneState {
            done: true,
            done_at: Some(1234.0),
            presentation_revision: Some(7),
        }
    );
    let undone = client.set_done("synthetic-session", false).await.unwrap();
    assert_eq!(
        undone,
        SessionDoneState {
            done: false,
            done_at: None,
            presentation_revision: Some(7),
        }
    );
    assert!(matches!(
        client.set_done("forbidden-session", true).await,
        Err(ManagedError::Http { .. })
    ));
    assert!(client.set_done("malformed-session", false).await.is_err());
    assert!(client.set_done("invalid/id", true).await.is_err());
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            ("synthetic-session".to_owned(), json!({"done":true})),
            ("synthetic-session".to_owned(), json!({"done":false})),
            ("forbidden-session".to_owned(), json!({"done":true})),
            ("malformed-session".to_owned(), json!({"done":false})),
        ]
    );
    eprintln!(
        "HTTP journey: PUT done=true -> done_at=1234; PUT done=false -> done_at=null; forbidden -> HTTP error; missing done -> response-schema error; malformed ID -> rejected before transport"
    );
    server.abort();
}

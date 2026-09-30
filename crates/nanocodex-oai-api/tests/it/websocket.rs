use eyre::{Result, eyre};
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use nanocodex_oai_api::{
    OpenAi, ResponseEvent, responses::ContentItem, session::ResponseInput,
    transport::ResponsesError,
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, time::timeout};
use tokio_tungstenite::{
    WebSocketStream, accept_async, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

#[tokio::test]
async fn dropping_a_streamed_response_reconnects_before_the_next_request() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut first_socket = accept_async(stream).await?;
        let first_request = next_ws_json(&mut first_socket).await?;
        assert!(first_request.to_string().contains("Abandon this response."));
        send_ws_json(
            &mut first_socket,
            json!({
                "type": "response.metadata",
                "headers": { "x-codex-turn-state": "cancelled-turn-state" }
            }),
        )
        .await?;
        send_ws_json(
            &mut first_socket,
            json!({
                "type": "response.output_text.delta",
                "output_index": 0,
                "delta": "partial"
            }),
        )
        .await?;

        let reconnected =
            match timeout(std::time::Duration::from_secs(2), first_socket.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let second_request: Value = serde_json::from_str(text.as_str())?;
                    assert!(second_request.to_string().contains("Answer this response."));
                    send_ws_json(
                        &mut first_socket,
                        completed_response("resp-stale", "stale abandoned response"),
                    )
                    .await?;
                    false
                }
                Ok(_) => {
                    let (stream, _) = listener.accept().await?;
                    let mut second_socket =
                        accept_hdr_async(stream, |request: &Request, response: Response| {
                            assert_eq!(
                                request
                                    .headers()
                                    .get("x-codex-turn-state")
                                    .and_then(|value| value.to_str().ok()),
                                Some("cancelled-turn-state")
                            );
                            Ok(response)
                        })
                        .await?;
                    let second_request = next_ws_json(&mut second_socket).await?;
                    assert!(second_request.to_string().contains("Answer this response."));
                    send_ws_json(
                        &mut second_socket,
                        completed_response("resp-fresh", "fresh response"),
                    )
                    .await?;
                    true
                }
                Err(_) => return Err(eyre!("cancelled response left its WebSocket open and idle")),
            };

        Ok::<_, eyre::Report>(reconnected)
    });

    let openai = OpenAi::builder("test-api-key")
        .websocket_url(websocket_url)
        .build()?;
    let mut session = openai
        .instructions("Answer only the active request.")
        .build()?;
    let mut turn = session.turn();

    let mut abandoned = turn.create("Abandon this response.");
    assert!(matches!(
        abandoned.try_next().await?,
        Some(ResponseEvent::OutputTextDelta(delta)) if delta == "partial"
    ));
    drop(abandoned);

    let completed = turn.create("Answer this response.").await?;
    assert_eq!(completed.output_text(), "fresh response");
    assert!(
        timeout(std::time::Duration::from_secs(5), server)
            .await
            .map_err(|_| eyre!("mock WebSocket server did not finish"))???
    );
    Ok(())
}

#[tokio::test]
async fn reconnect_replays_the_turn_state_in_the_websocket_handshake() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut first_socket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert!(request.headers().get("x-codex-turn-state").is_none());
            Ok(response)
        })
        .await?;
        drop(next_ws_json(&mut first_socket).await?);
        send_ws_json(
            &mut first_socket,
            json!({
                "type": "response.metadata",
                "headers": { "x-codex-turn-state": "sticky-turn-state" }
            }),
        )
        .await?;
        drop(first_socket);

        let (stream, _) = listener.accept().await?;
        let mut second_socket =
            accept_hdr_async(stream, |request: &Request, response: Response| {
                assert_eq!(
                    request
                        .headers()
                        .get("x-codex-turn-state")
                        .and_then(|value| value.to_str().ok()),
                    Some("sticky-turn-state")
                );
                Ok(response)
            })
            .await?;
        let replay = next_ws_json(&mut second_socket).await?;
        assert_eq!(
            replay["client_metadata"]["x-codex-turn-state"],
            "sticky-turn-state"
        );
        send_ws_json(
            &mut second_socket,
            completed_response("resp-reconnected", "reconnected response"),
        )
        .await
    });

    let openai = OpenAi::builder("test-api-key")
        .websocket_url(websocket_url)
        .build()?;
    let mut session = openai
        .instructions("Retry safely after a transport replacement.")
        .build()?;
    let completed = session.turn().create("Reconnect this response.").await?;
    assert_eq!(completed.output_text(), "reconnected response");
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock WebSocket reconnect server did not finish"))???;
    Ok(())
}

#[tokio::test]
async fn account_switch_error_reconnects_with_full_conversation_history() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut first = accept_async(stream).await?;
        drop(next_ws_json(&mut first).await?);
        send_ws_json(
            &mut first,
            completed_response("resp-account-a", "Earlier answer."),
        )
        .await?;
        let continuation = next_ws_json(&mut first).await?;
        assert_eq!(continuation["previous_response_id"], "resp-account-a");
        // This is the exact retry signal emitted by the hosted credential broker.
        send_ws_json(&mut first, json!({
            "type": "error",
            "error": {
                "type": "server_error",
                "code": "server_error",
                "retry_after": 0,
                "message": "ChatGPT account switched after reaching its subscription limit. Reconnect and retry with full history."
            }
        })).await?;
        let (stream, _) = listener.accept().await?;
        let mut second = accept_async(stream).await?;
        let replay = next_ws_json(&mut second).await?;
        assert!(replay.get("previous_response_id").is_none());
        let history = replay["input"].to_string();
        assert!(history.contains("Remember the first question."));
        assert!(history.contains("Earlier answer."));
        assert!(history.contains("Continue on another account."));
        send_ws_json(
            &mut second,
            completed_response("resp-account-b", "Continued answer."),
        )
        .await
    });
    let openai = OpenAi::builder("test-api-key")
        .websocket_url(websocket_url)
        .build()?;
    let mut session = openai
        .instructions("Preserve the conversation across accounts.")
        .build()?;
    let mut turn = session.turn();
    turn.create("Remember the first question.").await?;
    let completed = timeout(
        std::time::Duration::from_secs(10),
        turn.create("Continue on another account."),
    )
    .await??;
    assert_eq!(completed.output_text(), "Continued answer.");
    timeout(std::time::Duration::from_secs(5), server).await???;
    Ok(())
}

const PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/// A provider rejection of retained image data during `response.compact`
/// repairs committed history: the next `response.create` is a full replay
/// without the stale checkpoint and without the rejected image bytes, and the
/// replayed response becomes the next continuation checkpoint.
#[tokio::test]
async fn rejected_compaction_image_is_replaced_before_full_replay() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let websocket_url = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = accept_async(stream).await?;
        let first = next_ws_json(&mut socket).await?;
        assert!(first.to_string().contains(PNG_DATA_URL));
        send_ws_json(
            &mut socket,
            completed_response("resp-image", "A single pixel."),
        )
        .await?;

        let compact = next_ws_json(&mut socket).await?;
        assert!(compact.to_string().contains("compaction_trigger"));
        assert_eq!(compact["previous_response_id"], "resp-image");
        send_ws_json(
            &mut socket,
            json!({
                "type": "error",
                "status": 400,
                "error": {
                    "type": "invalid_request_error",
                    "code": "invalid_value",
                    "message": "Invalid 'input[1].content[1].image_url'. Expected a base64-encoded data URL with an image MIME type, but got an invalid base64-encoded value.",
                    "param": "input[1].content[1].image_url"
                }
            }),
        )
        .await?;

        let (mut socket, replay) = next_request_or_reconnect(socket, &listener).await?;
        assert!(replay.get("previous_response_id").is_none());
        let encoded = replay["input"].to_string();
        assert!(encoded.contains("Describe this image."));
        assert!(encoded.contains("A single pixel."));
        assert!(encoded.contains("image omitted after the provider rejected its data"));
        assert!(encoded.contains("Continue without the image."));
        assert!(!encoded.contains("input_image"));
        assert!(!encoded.contains("data:image/"));
        send_ws_json(
            &mut socket,
            completed_response("resp-replayed", "Continued."),
        )
        .await?;

        let continuation = next_ws_json(&mut socket).await?;
        assert_eq!(continuation["previous_response_id"], "resp-replayed");
        send_ws_json(&mut socket, completed_response("resp-next", "Next.")).await?;
        Ok::<_, eyre::Report>(vec![first, compact, replay, continuation])
    });

    let openai = OpenAi::builder("test-api-key")
        .websocket_url(websocket_url)
        .build()?;
    let mut session = openai.instructions("Describe images briefly.").build()?;
    session
        .turn()
        .create(ResponseInput::content([
            ContentItem::input_text("Describe this image."),
            ContentItem::input_image(PNG_DATA_URL),
        ]))
        .await?;
    let error = session
        .turn()
        .compact()
        .await
        .err()
        .ok_or_else(|| eyre!("the provider must reject the retained image"))?;
    assert!(matches!(
        error.responses_error(),
        Some(ResponsesError::InvalidImageRequest { .. })
    ));
    let replayed = timeout(
        std::time::Duration::from_secs(10),
        session.turn().create("Continue without the image."),
    )
    .await??;
    assert_eq!(replayed.output_text(), "Continued.");
    assert_eq!(
        session.turn().create("And then?").await?.output_text(),
        "Next."
    );
    let requests = timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock WebSocket image server did not finish"))???;
    if let Some(path) = std::env::var_os("NANOCODEX_E2E_TRANSCRIPT") {
        std::fs::write(path, serde_json::to_string_pretty(&requests)?)?;
    }
    Ok(())
}

/// Returns the next client request, accepting a replacement connection when
/// the client closes the socket after a terminal provider error.
async fn next_request_or_reconnect(
    mut socket: WebSocketStream<tokio::net::TcpStream>,
    listener: &TcpListener,
) -> Result<(WebSocketStream<tokio::net::TcpStream>, Value)> {
    match timeout(std::time::Duration::from_secs(2), socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => Ok((socket, serde_json::from_str(text.as_str())?)),
        Ok(_) => {
            let (stream, _) = listener.accept().await?;
            let mut socket = accept_async(stream).await?;
            let request = next_ws_json(&mut socket).await?;
            Ok((socket, request))
        }
        Err(_) => Err(eyre!("client neither retried nor reconnected")),
    }
}

async fn next_ws_json<S>(socket: &mut WebSocketStream<S>) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| eyre!("WebSocket closed before the client request"))??;
        if let Message::Text(text) = message {
            return Ok(serde_json::from_str(text.as_str())?);
        }
    }
}

async fn send_ws_json<S>(socket: &mut WebSocketStream<S>, value: Value) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

fn completed_response(response_id: &str, output_text: &str) -> Value {
    json!({
        "type": "response.completed",
        "response": {
            "id": response_id,
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": output_text
                }]
            }],
            "usage": null
        }
    })
}

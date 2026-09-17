//! Managed voice host. Shared Rust policy owns captions, handoffs and speech fencing;
//! this actor owns native media, authenticated transports, and session lifetime.
use futures_util::{StreamExt, future::AbortHandle};
use nanocodex_managed::{
    EventCursor, ManagedClient, ManagedError, ManagedEventData, ManagedVoiceSocket,
};
use nanocodex_voice_native::{RealtimeWebrtcSession, RealtimeWebrtcSessionHandle};
use nanocodex_voice_protocol::{BrowserVoiceEffects, ManagedVoiceProtocol, format_delegation};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
pub(crate) struct Args {
    /// Continue voice in an existing conversation; otherwise create one.
    #[arg(long)]
    pub agent: Option<String>,
    /// Realtime voice.
    #[arg(long, default_value = "cove", value_parser = clap::builder::PossibleValuesParser::new(nanocodex_voice_protocol::CHATGPT_REALTIME_VOICES.iter().copied()))]
    pub voice: String,
    /// Start with microphone muted.
    #[arg(long)]
    pub muted: bool,
    /// Stop after this many seconds (useful for connection checks).
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=3600))]
    pub duration: Option<u64>,
    #[command(flatten)]
    pub observability: nanocodex_observability::ObservabilityOutputArgs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Start,
    Stop,
    Mute,
    Unmute,
    Status,
}
impl Command {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "" | "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "mute" => Ok(Self::Mute),
            "unmute" => Ok(Self::Unmute),
            "status" => Ok(Self::Status),
            _ => Err("Usage: /voice [start|stop|mute|unmute|status]".into()),
        }
    }
}

enum Input {
    Typed,
}
#[derive(Clone, Debug)]
pub(crate) struct Status {
    pub text: String,
    pub finished: bool,
}
pub(crate) struct Session {
    stop: CancellationToken,
    native_stop: AbortHandle,
    control: Arc<Mutex<Option<RealtimeWebrtcSessionHandle>>>,
    input: mpsc::Sender<Input>,
    muted: watch::Sender<bool>,
    pub status: watch::Receiver<Status>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Session {
    pub(crate) fn start(
        client: ManagedClient,
        agent: String,
        voice: &str,
        muted: bool,
    ) -> Result<Self, ManagedError> {
        if !RealtimeWebrtcSession::is_supported() {
            return Err(error(
                "Voice runtime missing. Install the matching nightly voice package beside nanocodex2.",
            ));
        }
        let mut protocol = ManagedVoiceProtocol::new(voice).map_err(error)?;
        protocol.enable_client_managed_handoffs();
        let session = uuid::Uuid::now_v7().to_string();
        protocol.bind_session(&session);
        let stop = CancellationToken::new();
        let (native_stop, native_registration) = AbortHandle::new_pair();
        let (input, commands) = mpsc::channel(16);
        let (muted, microphone) = watch::channel(muted);
        let (status_tx, status) = watch::channel(Status {
            text: "Voice connecting…".into(),
            finished: false,
        });
        let control = Arc::new(Mutex::new(None));
        let actor_control = control.clone();
        let owner_stop = stop.clone();
        let owner_native_stop = native_stop.clone();
        let task = tokio::spawn(async move {
            let mut actor = Actor {
                client,
                agent,
                session,
                protocol,
                media: None,
                control: actor_control,
                status: status_tx,
                started: Instant::now(),
                prefetch: None,
                event_reader: None,
                speech_sent: None,
            };
            let result = tokio::select! {
                biased;
                () = owner_stop.cancelled() => Ok(()),
                result = actor.run(native_registration, commands, microphone) => result,
            };
            // Native capture/playback stops before any network cleanup.
            owner_native_stop.abort();
            if let Some(media) = actor.media.take() {
                media.close();
            }
            if let Some(task) = actor.event_reader.take() {
                task.abort();
            }
            if let Some(task) = actor.prefetch.take() {
                task.abort();
            }
            let final_status = match &result {
                Ok(()) => "Voice stopped".to_owned(),
                Err(error) => format!("Voice failed: {error}"),
            };
            actor.status.send_replace(Status {
                text: final_status.clone(),
                finished: false,
            });
            // Cleanup uses stable identities and remains bounded even when a call was
            // cancelled during admission. A stale stop cannot close a newer session.
            let cleanup = tokio::time::timeout(Duration::from_secs(10), actor.cleanup()).await;
            let text = match cleanup {
                Ok(Ok(())) => final_status,
                _ => format!("{final_status}; remote cleanup unconfirmed"),
            };
            actor.status.send_replace(Status {
                text,
                finished: true,
            });
        });
        Ok(Self {
            stop,
            native_stop,
            control,
            input,
            muted,
            status,
            task: Some(task),
        })
    }
    pub(crate) fn stop(&self) {
        self.native_stop.abort();
        self.stop.cancel();
    }
    pub(crate) fn is_muted(&self) -> bool {
        *self.muted.borrow()
    }
    pub(crate) fn mute(&self, muted: bool) {
        let control = self
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.muted.send_replace(muted);
        if let Some(media) = control.as_ref()
            && media.set_microphone_muted(muted).is_err()
        {
            self.stop();
        }
    }
    pub(crate) fn typed(&self) {
        if let Some(media) = self
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            media.set_speaker_suppressed(true);
        }
        if self.input.try_send(Input::Typed).is_err() {
            self.stop();
        }
    }
    pub(crate) async fn finish(mut self) {
        self.stop();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Actor {
    client: ManagedClient,
    agent: String,
    session: String,
    protocol: ManagedVoiceProtocol,
    media: Option<RealtimeWebrtcSessionHandle>,
    control: Arc<Mutex<Option<RealtimeWebrtcSessionHandle>>>,
    status: watch::Sender<Status>,
    started: Instant,
    prefetch: Option<tokio::task::JoinHandle<()>>,
    event_reader: Option<tokio::task::JoinHandle<()>>,
    speech_sent: Option<Instant>,
}
impl Actor {
    fn status(&self, text: impl Into<String>) {
        self.status.send_replace(Status {
            text: text.into(),
            finished: false,
        });
    }
    fn timing(&self, stage: &str) {
        tracing::info!(target: "nanocodex2::voice", stage, elapsed_ms = self.started.elapsed().as_millis() as u64, "voice timing");
    }
    async fn run(
        &mut self,
        registration: futures_util::future::AbortRegistration,
        mut commands: mpsc::Receiver<Input>,
        mut muted: watch::Receiver<bool>,
    ) -> Result<(), ManagedError> {
        let client = self.client.clone();
        let agent = self.agent.clone();
        let session = self.session.clone();
        let start_id = uuid::Uuid::new_v4().to_string();
        let start = async {
            let (state, admitted) = tokio::try_join!(
                client.state(&agent),
                client.voice_operation(
                    &agent,
                    &session,
                    "start",
                    json!({"operation_id": start_id})
                )
            )?;
            Ok::<_, ManagedError>((state, admitted))
        };
        let settings = self
            .protocol
            .dispatch(&json!({"op":"session"}))
            .map_err(error)?;
        let media = async {
            let started =
                tokio::task::spawn_blocking(move || RealtimeWebrtcSession::start(registration))
                    .await
                    .map_err(|_| error("Voice startup task failed"))?
                    .map_err(|e| error(e.to_string()))?;
            {
                let mut control = self
                    .control
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                started
                    .handle
                    .set_microphone_muted(*muted.borrow())
                    .map_err(|e| error(e.to_string()))?;
                *control = Some(started.handle.clone());
            }
            self.media = Some(started.handle.clone());
            self.timing("native.offer");
            let call = self
                .client
                .voice_call(&self.agent, &self.session, &started.offer_sdp, settings)
                .await?;
            self.timing("call.answer");
            let handle = started.handle;
            let answer = async {
                tokio::task::spawn_blocking(move || handle.apply_answer_sdp(call.sdp))
                    .await
                    .map_err(|_| error("Voice answer task failed"))?
                    .map_err(|e| error(e.to_string()))?;
                self.timing("native.connected");
                Ok::<_, ManagedError>(())
            };
            let sideband = async {
                let socket = self
                    .client
                    .voice_sideband(&self.agent, &self.session, &call.call_id)
                    .await?;
                self.timing("sideband.ready");
                Ok::<_, ManagedError>(socket)
            };
            let ((), socket) = tokio::try_join!(answer, sideband)?;
            self.timing("media.ready");
            self.status("Voice media connected; preparing agent…");
            Ok::<_, ManagedError>((socket, call.call_id))
        };
        let ((state, admitted), (mut socket, call)) = tokio::try_join!(start, media)?;
        self.timing("agent.ready");
        let events = self
            .client
            .events(&self.agent, EventCursor::parse(state.latest_event_cursor)?)?;
        // Keep connection establishment alive while the realtime channel is busy.
        // Polling SSE next() directly in select would cancel its HTTP handshake
        // every time an audio/control event wins, starving agent output.
        let (event_sender, mut agent_events) = mpsc::channel(128);
        self.event_reader = Some(spawn_event_reader(events, event_sender));
        let frames = self
            .protocol
            .dispatch(&json!({"op":"startup_context","context":admitted["context"]}))
            .map_err(error)?;
        if let Some(frames) = frames.as_array() {
            for frame in frames {
                socket.send(&frame.to_string()).await?;
            }
        }
        let effects = self.protocol.sideband_opened();
        self.apply(&mut socket, effects).await?;
        let mut connected = Instant::now();
        let mut active_turn: Option<String> = None;
        let mut flush = tokio::time::interval(Duration::from_millis(100));
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut first_audio = false;
        let mut first_input = false;
        self.status(if *muted.borrow() {
            "Voice active · microphone muted"
        } else {
            "Voice active · listening"
        });
        loop {
            tokio::select! {
                biased;
                changed = muted.changed() => {
                    changed.map_err(|_| error("Voice controls closed"))?;
                    self.status(if *muted.borrow() { "Voice active · microphone muted" } else { "Voice active · listening" });
                }
                command = commands.recv() => match command {
                    Some(Input::Typed) => { active_turn = None; let effects = self.protocol.note_typed_input(); self.apply(&mut socket, effects).await?; }
                    None => return Ok(()),
                },
                received = socket.next() => {
                    let event = match received {
                        Ok(event) => event,
                        Err(_) => {
                            let effects = self.protocol.sideband_closed(connected.elapsed().as_millis() as u64);
                            self.status("Voice reconnecting…");
                            tokio::time::sleep(Duration::from_millis(effects.reconnect_after_ms.unwrap_or(200))).await;
                            socket = self.client.voice_sideband(&self.agent, &self.session, &call).await?;
                            connected = Instant::now();
                            let effects = self.protocol.sideband_opened(); self.apply(&mut socket, effects).await?;
                            continue;
                        }
                    };
                    if let Some(kind @ ("session.started" | "delegation.created" | "turn.done" | "error")) = event["type"].as_str() { self.timing(&format!("realtime.{kind}")); }
                    let update = self.protocol.realtime_message(&event.to_string());
                    self.apply(&mut socket, update.effects).await?;
                    if let Some(prefetch) = update.prefetch {
                        if let Some(task) = self.prefetch.take() { task.abort(); }
                        let client = self.client.clone(); let agent = self.agent.clone(); let session = self.session.clone();
                        self.prefetch = Some(tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(u64::from(prefetch.debounce_ms))).await;
                            let _ = tokio::time::timeout(Duration::from_secs(10), client.voice_operation(&agent, &session, "prefetch", json!({"query":prefetch.query}))).await;
                        }));
                    }
                    if let Some(delegation) = update.delegation {
                        if let Some(task) = self.prefetch.take() { task.abort(); }
                        self.timing("delegation.received");
                        let route = self.client.voice_operation(&self.agent, &self.session, "delegate", json!({"operation_id":uuid::Uuid::new_v4().to_string(), "input":format_delegation(&delegation)})).await?;
                        active_turn = route["turn_id"].as_str().map(str::to_owned);
                        self.timing("delegation.admitted");
                    }
                }
                event = agent_events.recv() => {
                    let event = event.ok_or_else(|| error("Voice agent event stream closed"))??;
                    if let ManagedEventData::StreamFailed { .. } = &event.data { return Err(error("Voice agent event stream failed")); }
                    let envelope = serde_json::to_value(&event).map_err(|e| error(e.to_string()))?;
                    let context = self.protocol.managed_event(&envelope);
                    self.apply(&mut socket, context).await?;
                    if event.turn_id.as_ref() == active_turn.as_ref() && active_turn.is_some() {
                        if let ManagedEventData::Event {event, agent_id: None} = &event.data {
                            let effects = self.protocol.agent_event(event.get()); self.apply(&mut socket, effects).await?;
                        }
                        if matches!(&event.data, ManagedEventData::TurnFailed {..}) {
                            let effects = self.protocol.agent_event(&envelope.to_string()); self.apply(&mut socket, effects).await?;
                        }
                        if matches!(&event.data, ManagedEventData::TurnCancelled {..}) {
                            let effects = self.protocol.note_typed_input(); self.apply(&mut socket, effects).await?;
                        }
                        if matches!(&event.data, ManagedEventData::TurnCompleted {..} | ManagedEventData::TurnFailed {..} | ManagedEventData::TurnCancelled {..}) { active_turn = None; }
                    }
                }
                _ = flush.tick() => {
                    let media = self.media.as_ref().unwrap();
                    if let Some(error_text) = media.take_error() { return Err(error(error_text)); }
                    if media.take_microphone_peak() > 200 && !first_input { first_input = true; self.timing("input.first_energy"); }
                    if media.take_speaker_peak() > 200 {
                        if !first_audio { first_audio = true; self.timing("audio.first_energy"); }
                        if let Some(sent) = self.speech_sent.take() {
                            self.timing("speech.first_energy");
                            tracing::info!(target: "nanocodex2::voice", stage = "speech.latency", elapsed_ms = sent.elapsed().as_millis() as u64, "voice timing");
                        }
                    }
                    let effects = self.protocol.flush(false); self.apply(&mut socket, effects).await?;
                }
            }
        }
    }
    async fn apply(
        &mut self,
        socket: &mut ManagedVoiceSocket,
        effects: BrowserVoiceEffects,
    ) -> Result<(), ManagedError> {
        if let Some(enabled) = effects.playback_enabled
            && let Some(media) = &self.media
        {
            media.set_speaker_suppressed(!enabled);
        }
        if let Some(status) = effects.status {
            self.status(status);
        }
        for transcript in effects.transcripts {
            if !transcript.is_partial {
                self.status(format!("Voice {}: {}", transcript.speaker, transcript.text));
            }
        }
        if effects.ready == Some(true) {
            self.timing("protocol.ready");
        }
        for frame in &effects.frames {
            socket.send(frame).await?;
            if frame.contains("speakable") {
                if let Some(media) = &self.media {
                    media.take_speaker_peak();
                }
                self.speech_sent = Some(Instant::now());
                self.timing("speech.frame.sent");
            }
            if effects.acknowledge_frames {
                self.protocol.frames_sent(1);
            }
        }
        for answer in effects.undelivered_answers {
            self.status(format!("Voice reply available as text: {answer}"));
        }
        if let Some(reason) = effects.terminate {
            return Err(error(reason));
        }
        Ok(())
    }
    async fn cleanup(&mut self) -> Result<(), ManagedError> {
        let tail = self
            .protocol
            .dispatch(&json!({"op":"tail"}))
            .map_err(error)?;
        let mut tail_error = None;
        if let Some(input) = tail.as_str().filter(|text| !text.trim().is_empty()) {
            tail_error = self
                .client
                .voice_operation(
                    &self.agent,
                    &self.session,
                    "delegate",
                    json!({"operation_id":uuid::Uuid::new_v4().to_string(),"input":input}),
                )
                .await
                .err();
        }
        self.client
            .voice_operation(
                &self.agent,
                &self.session,
                "stop",
                json!({"operation_id":uuid::Uuid::new_v4().to_string()}),
            )
            .await?;
        if let Some(error) = tail_error {
            return Err(error);
        }
        Ok(())
    }
}
fn spawn_event_reader(
    mut events: nanocodex_managed::ManagedEventStream,
    sender: mpsc::Sender<Result<nanocodex_managed::ManagedEvent, ManagedError>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let event = events.next().await;
            let failed = event.is_err();
            if sender.send(event).await.is_err() || failed {
                break;
            }
        }
    })
}
impl Drop for Actor {
    fn drop(&mut self) {
        if let Some(task) = &self.event_reader {
            task.abort();
        }
        if let Some(task) = &self.prefetch {
            task.abort();
        }
        if let Some(media) = &self.media {
            media.close();
        }
    }
}
fn error(message: impl Into<String>) -> ManagedError {
    ManagedError::Configuration(message.into())
}

pub(crate) async fn run(client: &ManagedClient, args: Args) -> Result<(), ManagedError> {
    let _logs = args
        .observability
        .install(
            "nanocodex2-voice",
            env!("CARGO_PKG_VERSION"),
            "warn,nanocodex2::voice=info",
            "warn,nanocodex2::voice=info",
            nanocodex_observability::LogOutput::Stderr,
        )
        .map_err(|e| error(e.to_string()))?;
    let (agent, mut workspace_events, id, _) =
        super::open_workspace_agent_from(client, args.agent, None, None).await?;
    eprintln!("Managed agent: {id}");
    let session = Session::start(client.clone(), id, &args.voice, args.muted)?;
    let mut status = session.status.clone();
    let deadline = tokio::time::sleep(Duration::from_secs(args.duration.unwrap_or(86400)));
    tokio::pin!(deadline);
    let mut failure = None;
    loop {
        tokio::select! {
            _ = workspace_events.next() => {},
            _ = tokio::signal::ctrl_c() => break,
            _ = &mut deadline => break,
            changed = status.changed() => {
                if changed.is_err() { break; }
                let value = status.borrow_and_update().clone();
                println!("{}", json!({"type":"voice.status","text":value.text,"finished":value.finished}));
                if value.finished { if value.text.starts_with("Voice failed") { failure = Some(error(value.text)); } break; }
            }
        }
    }
    session.finish().await;
    let final_status = status.borrow().clone();
    println!(
        "{}",
        json!({"type":"voice.status","text":final_status.text,"finished":final_status.finished})
    );
    if failure.is_none()
        && (final_status.text.starts_with("Voice failed")
            || final_status.text.contains("cleanup unconfirmed"))
    {
        failure = Some(error(final_status.text));
    }
    agent.disconnect().await.map_err(super::agent_error)?;
    failure.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn busy_realtime_events_do_not_cancel_agent_stream_connection() {
        use axum::{Router, http::header, routing::get};
        use nanocodex_managed::ManagedApiKey;
        let app = Router::new().route("/v1/agents/agent-test/events", get(|| async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            ([(header::CONTENT_TYPE, "text/event-stream")], "id: 1\nevent: event\ndata: {\"cursor\":\"1\",\"type\":\"event\",\"turn_id\":\"turn-1\",\"event\":{\"type\":\"assistant.message\",\"payload\":{\"text\":\"answer\"}}}\n\n")
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let key = ManagedApiKey::parse(format!("ncx_live_{}_{}", "a".repeat(12), "b".repeat(43)))
            .unwrap();
        let client = ManagedClient::new(format!("http://{address}"), key).unwrap();
        let events = client
            .events("agent-test", EventCursor::parse("0").unwrap())
            .unwrap();
        let (sender, mut receiver) = mpsc::channel(1);
        let reader = spawn_event_reader(events, sender);
        let mut audio = tokio::time::interval(Duration::from_millis(2));
        let mut ticks = 0;
        let event = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = audio.tick() => ticks += 1,
                    event = receiver.recv() => break event.unwrap().unwrap(),
                }
            }
        })
        .await
        .unwrap();
        assert!(ticks > 10);
        assert_eq!(event.cursor, "1");
        reader.abort();
        server.abort();
    }
    #[test]
    fn voice_controls_have_explicit_start_stop_and_privacy_transitions() {
        assert_eq!(Command::parse("").unwrap(), Command::Start);
        for (text, command) in [
            ("start", Command::Start),
            ("stop", Command::Stop),
            ("mute", Command::Mute),
            ("unmute", Command::Unmute),
            ("status", Command::Status),
        ] {
            assert_eq!(Command::parse(text).unwrap(), command);
        }
        assert!(Command::parse("mute now").is_err());
    }
}

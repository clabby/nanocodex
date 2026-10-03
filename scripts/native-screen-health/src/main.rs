//! Read-only live WebRTC H264 -> native decoder pixel hash proof.
//! Authentication uses the shipped CLI selection abstraction; no credentials,
//! URLs, SDP, ICE candidates or server error bodies are ever emitted.
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use webrtc::{
    api::{
        APIBuilder, interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
    },
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    peer_connection::{
        configuration::RTCConfiguration, sdp::session_description::RTCSessionDescription,
    },
    rtp::{codecs::h264::H264Packet, packetizer::Depacketizer},
};

#[derive(Default)]
struct Evidence {
    packets: AtomicU64,
    bytes: AtomicU64,
    nals: AtomicU64,
    depacketize_errors: AtomicU64,
    sequence_gaps: AtomicU64,
    decoded: AtomicU64,
    dimensions: Mutex<String>,
    hashes: Mutex<Vec<String>>,
    codec: Mutex<String>,
    states: Mutex<Vec<String>>,
}
impl Evidence {
    fn report(&self, status: &str, stage: &str) -> Value {
        json!({"status":status,"stage":stage,"transport":"webrtc","read_only":true,
            "jpeg_fallback":false,"codec":*self.codec.lock().unwrap(),
            "rtp_packets":self.packets.load(Ordering::Relaxed),"rtp_payload_bytes":self.bytes.load(Ordering::Relaxed),
            "annexb_nals":self.nals.load(Ordering::Relaxed),"depacketize_errors":self.depacketize_errors.load(Ordering::Relaxed),
            "rtp_sequence_gaps":self.sequence_gaps.load(Ordering::Relaxed),
            "native_decoded_frames":self.decoded.load(Ordering::Relaxed),
            "decoded_dimensions":*self.dimensions.lock().unwrap(),
            "decoded_pixel_md5":*self.hashes.lock().unwrap(),"peer_states":*self.states.lock().unwrap()})
    }
}
fn failure(stage: &str) -> String {
    stage.to_owned()
}
async fn json_request(
    client: &reqwest::Client,
    origin: &str,
    key: &str,
    path: &str,
    post: Option<Value>,
) -> Result<Value, String> {
    let mut request = if post.is_some() {
        client.post(format!("{origin}{path}"))
    } else {
        client.get(format!("{origin}{path}"))
    };
    request = request.bearer_auth(key);
    if let Some(body) = post {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| failure("account_network"))?;
    if !response.status().is_success() {
        return Err(format!("account_http_{}", response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| failure("account_body"))?;
    if bytes.len() > 131072 {
        return Err(failure("account_body_limit"));
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("account_json"))
}
async fn run(machine: &str, surface: &str, e: Arc<Evidence>) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (origin, key) = nanocodex_cli_auth::enrollment_credentials(None)
        .map_err(|_| failure("user_login_required"))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| failure("http_client"))?;
    let catalog = json_request(&client, &origin, &key, "/v1/account/hands/screens", None).await?;
    let hand = catalog["surfaces"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|h| h["machine_id"] == machine && h["id"] == surface)
        })
        .ok_or_else(|| failure("target_not_published"))?;
    if hand["transport"] == "frames-v1" {
        return Err(failure("target_not_webrtc"));
    }
    let generation = hand["generation"]
        .as_str()
        .ok_or_else(|| failure("target_generation"))?;
    let ice = json_request(
        &client,
        &origin,
        &key,
        "/v1/account/hands/ice",
        Some(json!({})),
    )
    .await?;
    let mut servers = Vec::new();
    for server in ice["iceServers"]
        .as_array()
        .filter(|rows| rows.len() <= 16)
        .ok_or_else(|| failure("ice_config"))?
    {
        let urls = if let Some(s) = server["urls"].as_str() {
            vec![s.to_owned()]
        } else {
            server["urls"]
                .as_array()
                .ok_or_else(|| failure("ice_urls"))?
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        servers.push(RTCIceServer {
            urls,
            username: server["username"].as_str().unwrap_or_default().into(),
            credential: server["credential"].as_str().unwrap_or_default().into(),
        });
    }
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .map_err(|_| failure("media_engine"))?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .map_err(|_| failure("interceptors"))?;
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();
    let peer = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers: servers,
            ..Default::default()
        })
        .await
        .map_err(|_| failure("peer_create"))?,
    );
    let (signals, mut pending_signals) = mpsc::channel::<Value>(128);
    let tx = signals.clone();
    peer.on_ice_candidate(Box::new(move |candidate| {let tx=tx.clone();Box::pin(async move {if let Some(c)=candidate {if let Ok(c)=c.to_json() {let _=tx.try_send(json!({"type":"signal","signal":{"type":"candidate","candidate":c.candidate,"sdpMid":c.sdp_mid,"sdpMLineIndex":c.sdp_mline_index}}));}}})}));
    let states = e.clone();
    peer.on_peer_connection_state_change(Box::new(move |state| {
        let states = states.clone();
        Box::pin(async move {
            let mut values = states.states.lock().unwrap();
            if values.len() < 12 {
                values.push(state.to_string());
            }
        })
    }));
    let decoder_e = e.clone();
    peer.on_track(Box::new(move |track, _, _| {
        let e = decoder_e.clone();
        Box::pin(async move {
            if !track
                .codec()
                .capability
                .mime_type
                .eq_ignore_ascii_case("video/H264")
            {
                return;
            }
            *e.codec.lock().unwrap() = "H264".into();
            // No pixels are written to disk or stdout. Framemd5 hashes decoded planes.
            let mut child = match tokio::process::Command::new("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "quiet",
                    "-threads",
                    "1",
                    "-probesize",
                    "32768",
                    "-analyzeduration",
                    "0",
                    "-f",
                    "h264",
                    "-i",
                    "pipe:0",
                    "-an",
                    "-c:v",
                    "rawvideo",
                    "-threads",
                    "1",
                    "-f",
                    "framemd5",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(_) => return,
            };
            let mut input = child.stdin.take().unwrap();
            let output = child.stdout.take().unwrap();
            let hashes_e = e.clone();
            let reader = tokio::spawn(async move {
                let mut lines = BufReader::new(output).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(d) = line.strip_prefix("#dimensions 0: ") {
                        if d.len() < 32 && d.chars().all(|c| c.is_ascii_digit() || c == 'x') {
                            *hashes_e.dimensions.lock().unwrap() = d.into();
                        }
                    }
                    if line.starts_with('#') {
                        continue;
                    }
                    let columns: Vec<_> = line.split(',').map(str::trim).collect();
                    if columns.len() == 6
                        && columns[5].len() == 32
                        && columns[5].chars().all(|c| c.is_ascii_hexdigit())
                    {
                        hashes_e.decoded.fetch_add(1, Ordering::Relaxed);
                        let mut hashes = hashes_e.hashes.lock().unwrap();
                        if hashes.len() < 8 {
                            hashes.push(columns[5].into());
                        }
                    }
                }
            });
            let mut depacketizer = H264Packet::default();
            let mut previous: Option<u16> = None;
            loop {
                let packet =
                    match tokio::time::timeout(Duration::from_secs(5), track.read_rtp()).await {
                        Ok(Ok((p, _))) => p,
                        _ => break,
                    };
                e.packets.fetch_add(1, Ordering::Relaxed);
                e.bytes
                    .fetch_add(packet.payload.len() as u64, Ordering::Relaxed);
                if let Some(seq) = previous {
                    if packet.header.sequence_number != seq.wrapping_add(1) {
                        e.sequence_gaps.fetch_add(1, Ordering::Relaxed);
                        depacketizer = H264Packet::default();
                    }
                }
                previous = Some(packet.header.sequence_number);
                match depacketizer.depacketize(&packet.payload) {
                    Ok(nal) if !nal.is_empty() => {
                        e.nals.fetch_add(1, Ordering::Relaxed);
                        if input.write_all(&nal).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        e.depacketize_errors.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
            drop(input);
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
        })
    }));
    let mut url = url::Url::parse(&origin).map_err(|_| failure("account_origin"))?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| failure("socket_scheme"))?;
    url.set_path("/v1/account/hands/view");
    url.query_pairs_mut()
        .append_pair("machine_id", machine)
        .append_pair("surface_id", surface)
        .append_pair("generation", generation);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| failure("socket_request"))?;
    let mut auth: tokio_tungstenite::tungstenite::http::HeaderValue = format!("Bearer {}", &*key)
        .parse()
        .map_err(|_| failure("authorization_header"))?;
    auth.set_sensitive(true);
    request.headers_mut().insert("Authorization", auth);
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|_| failure("viewer_admission"))?;
    let (mut sender, mut receiver) = socket.split();
    let deadline = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(deadline);
    let mut renew = tokio::time::interval(Duration::from_secs(10));
    renew.tick().await;
    let mut connection_id = String::new();
    let mut candidates = Vec::new();
    let mut offered = false;
    let result=async {loop {tokio::select! {
        _=&mut deadline=>break,
        Some(signal)=pending_signals.recv()=>{sender.send(Message::Text(signal.to_string().into())).await.map_err(|_|failure("signal_send"))?;},
        _=renew.tick(),if !connection_id.is_empty()=>{json_request(&client,&origin,&key,"/v1/account/hands/renew",Some(json!({"connection_id":connection_id}))).await?;sender.send(Message::Text(json!({"type":"ping"}).to_string().into())).await.map_err(|_|failure("renew_ping"))?;},
        wire=receiver.next()=>{
            let wire=wire.ok_or_else(||failure("signaling_closed"))?.map_err(|_|failure("signaling_receive"))?;
            let Message::Text(text)=wire else {continue;};if text.len()>70000{return Err(failure("signaling_limit"));}
            let message:Value=serde_json::from_str(&text).map_err(|_|failure("signaling_json"))?;
            match message["type"].as_str().unwrap_or_default(){
                "ready"=>{connection_id=message["connection_id"].as_str().filter(|id|id.len()<=128).ok_or_else(||failure("viewer_lease"))?.into();},
                "signal"=>{let signal=&message["signal"];match signal["type"].as_str().unwrap_or_default(){
                    "offer"=>{let sdp=signal["sdp"].as_str().filter(|s|s.len()<=65536).ok_or_else(||failure("offer_limit"))?;
                        peer.set_remote_description(RTCSessionDescription::offer(sdp.into()).map_err(|_|failure("offer_parse"))?).await.map_err(|_|failure("offer_apply"))?;
                        let answer=peer.create_answer(None).await.map_err(|_|failure("answer_create"))?;
                        peer.set_local_description(answer.clone()).await.map_err(|_|failure("answer_apply"))?;offered=true;
                        sender.send(Message::Text(json!({"type":"signal","signal":{"type":"answer","sdp":answer.sdp}}).to_string().into())).await.map_err(|_|failure("answer_send"))?;
                        for candidate in candidates.drain(..){peer.add_ice_candidate(candidate).await.map_err(|_|failure("candidate_apply"))?;}
                    },
                    "candidate"=>{let c:RTCIceCandidateInit=serde_json::from_value(signal.clone()).map_err(|_|failure("candidate_parse"))?;if c.candidate.len()>4096{return Err(failure("candidate_limit"));}if offered{peer.add_ice_candidate(c).await.map_err(|_|failure("candidate_apply"))?;}else if candidates.len()<128{candidates.push(c);}else{return Err(failure("candidate_queue"));}},
                    _=>return Err(failure("unknown_signal"))
                }},
                "renewed"|"pong"=>{},"error"=>return Err(failure("broker_error")),_=>{}
            }
        }
    }} Ok(())}.await;
    let _ = peer.close().await;
    let _ = sender.close().await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    result?;
    if e.decoded.load(Ordering::Relaxed) < 2 {
        return Err(failure("decoded_frames_missing"));
    }
    Ok(())
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let e = Arc::new(Evidence::default());
    if args.len() != 3 {
        println!("{}", e.report("failed", "usage_machine_surface"));
        std::process::exit(2);
    }
    let result =
        tokio::time::timeout(Duration::from_secs(65), run(&args[1], &args[2], e.clone())).await;
    let (status, stage) = match result {
        Ok(Ok(())) => ("passed", "live_decoded_h264"),
        Ok(Err(ref stage)) => ("failed", stage.as_str()),
        Err(_) => ("failed", "diagnostic_timeout"),
    };
    println!("{}", e.report(status, stage));
    if status != "passed" {
        std::process::exit(1);
    }
}

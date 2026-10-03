//! Private, bounded local workflow evidence. Capture and privacy filtering belong to the adapter.
//! Opening a store never starts capture. All mutations are serialized and durably persisted.
use crate::Error;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_STORE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORDINGS: usize = 100;
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Configurable downward only; defaults are hard ceilings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_duration_ms: u64,
    pub max_events: usize,
    pub max_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_duration_ms: 3_600_000,
            max_events: 10_000,
            max_bytes: 64 * 1024 * 1024,
        }
    }
}
impl Limits {
    fn validate(&self) -> Result<(), Error> {
        let cap = Self::default();
        if self.max_duration_ms == 0
            || self.max_duration_ms > cap.max_duration_ms
            || self.max_events == 0
            || self.max_events > cap.max_events
            || self.max_bytes < 4096
            || self.max_bytes > cap.max_bytes
        {
            return Err("invalid recording limits".into());
        }
        Ok(())
    }
}

/// Explicit foreground allowlist. IDs come from the native observer, never window titles.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub windows: Vec<String>,
    #[serde(default)]
    pub exclude_apps: Vec<String>,
    #[serde(default)]
    pub capture_frames: bool,
}
impl Scope {
    fn validate(&self) -> Result<(), Error> {
        if self.apps.is_empty() && self.windows.is_empty() {
            return Err("recording requires an explicit app or window allowlist".into());
        }
        if self.apps.len() > 32 || self.windows.len() > 32 || self.exclude_apps.len() > 32 {
            return Err("recording scope exceeds limit".into());
        }
        for id in self.apps.iter().chain(self.exclude_apps.iter()) {
            validate_context_id(id, true)?;
        }
        for id in &self.windows {
            validate_context_id(id, false)?;
        }
        Ok(())
    }
}
fn validate_context_id(id: &str, app: bool) -> Result<(), Error> {
    let valid = if app {
        id.strip_prefix("pid:")
            .or_else(|| id.strip_prefix("x11-window:"))
            .is_some_and(decimal)
    } else if let Some(value) = id.strip_prefix("x11:") {
        decimal(value)
    } else if let Some(value) = id.strip_prefix("hwnd:") {
        !value.is_empty() && value.bytes().all(|b| b.is_ascii_hexdigit())
    } else if let Some(value) = id.strip_prefix("ax:") {
        value
            .split_once(':')
            .is_some_and(|(pid, serial)| decimal(pid) && decimal(serial))
    } else {
        false
    };
    if !valid || id.len() > 80 {
        return Err("invalid native context id".into());
    }
    Ok(())
}
fn decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    Other,
}
/// Intentionally cannot carry text, key names/codes, clipboard content or arbitrary JSON.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SafeEvent {
    Pointer { x: i32, y: i32 },
    Button { button: MouseButton, pressed: bool },
    Scroll { dx: i32, dy: i32 },
    KeyActivity { count: u32 },
    Focus { app_id: String, window_id: String },
    Suppressed { reason: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameMime {
    Png,
    Jpeg,
}
/// Only pass bytes after the capture adapter's privacy checks and masking have succeeded.
pub struct FilteredFrame<'a> {
    pub bytes: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub mime: FrameMime,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Evidence {
    Lifecycle {
        state: State,
        reason: Option<String>,
    },
    Input {
        event: SafeEvent,
    },
    Frame {
        sha256: String,
        bytes: usize,
        width: u32,
        height: u32,
        mime: FrameMime,
    },
}
/// Attribution supplied only when known; native polling must use Unknown.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Human,
    Agent,
    #[default]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    sequence: u64,
    timestamp_ms: u64,
    #[serde(default)]
    source: Source,
    evidence: Evidence,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum State {
    Recording,
    Paused,
    Stopped,
    Interrupted,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    id: String,
    state: State,
    stop_reason: Option<String>,
    created_at_ms: u64,
    updated_at_ms: u64,
    limits: Limits,
    scope: Scope,
    events: Vec<Entry>,
}
impl Record {
    fn lifecycle(&mut self, state: State, reason: Option<&str>) {
        self.state = state.clone();
        self.stop_reason = reason.map(str::to_owned);
        self.updated_at_ms = now().max(self.updated_at_ms);
        if self.events.len() < self.limits.max_events {
            self.events.push(Entry {
                sequence: self.events.len() as u64,
                timestamp_ms: self.updated_at_ms,
                source: Source::Unknown,
                evidence: Evidence::Lifecycle {
                    state,
                    reason: self.stop_reason.clone(),
                },
            });
        }
    }

    fn active(&self) -> bool {
        matches!(self.state, State::Recording | State::Paused)
    }
    fn metadata(&self) -> Value {
        json!({"id":self.id,"state":self.state,"stop_reason":self.stop_reason,"created_at_ms":self.created_at_ms,"updated_at_ms":self.updated_at_ms,"limits":self.limits,"scope":self.scope,"retention_expires_at_ms":if self.active(){None}else{Some(self.updated_at_ms.saturating_add(RETENTION_MS))},"event_count":self.events.len(),"frame_count":self.events.iter().filter(|e|matches!(e.evidence,Evidence::Frame{..})).count()})
    }
}

/// Strict external request vocabulary; append is available only through typed Rust methods.
#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Start {
        scope: Scope,
        limits: Option<Limits>,
    },
    Pause {
        id: String,
    },
    Resume {
        id: String,
    },
    Stop {
        id: String,
    },
    Status {
        id: Option<String>,
    },
    List {
        cursor: Option<usize>,
        limit: Option<usize>,
    },
    Read {
        id: String,
        cursor: Option<usize>,
        limit: Option<usize>,
    },
    Export {
        id: String,
        cursor: Option<usize>,
        limit: Option<usize>,
    },
    Frame {
        id: String,
        sha256: String,
        offset: Option<usize>,
        length: Option<usize>,
    },
    Delete {
        id: String,
    },
}
struct Inner {
    records: BTreeMap<String, Record>,
}
/// Keep this store alive for the lifetime of the Hand, independently of transport connections.
pub struct Store {
    root: PathBuf,
    inner: Mutex<Inner>,
    _lock: File,
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        // Unix modes below cannot establish Windows ACL privacy. Fail closed
        // for direct store consumers as well as the native recording service.
        if cfg!(windows) {
            return Err("private recording storage unavailable on Windows".into());
        }
        let root = path.as_ref().to_path_buf();
        private_dir(&root)?;
        let lock_path = root.join("store.lock");
        reject_symlink(&lock_path)?;
        let lock = private_file(&lock_path, false)?;
        lock.try_lock_exclusive()
            .map_err(|_| "recording store is already open")?;
        let mut records = BTreeMap::new();
        for item in fs::read_dir(&root)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().to_string();
            if name == "store.lock" {
                continue;
            }
            if let Some(id) = name.strip_prefix("deleted_") {
                validate_id(id)?;
                reject_symlink(&item.path())?;
                fs::remove_dir_all(item.path())?;
                continue;
            }
            validate_id(&name)?;
            reject_symlink(&item.path())?;
            if !item.file_type()?.is_dir() {
                return Err("unexpected recording store entry".into());
            }
            let manifest = item.path().join("manifest.json");
            reject_symlink(&manifest)?;
            // A directory without its first committed manifest is an incomplete start.
            if !manifest.exists() {
                fs::remove_dir_all(item.path())?;
                continue;
            }
            if fs::metadata(&manifest)?.len() > 16 * 1024 * 1024 {
                return Err("recording manifest exceeds safety bound".into());
            }
            let mut record: Record = serde_json::from_slice(&fs::read(&manifest)?)?;
            record.limits.validate()?;
            record.scope.validate()?;
            if record.id != name
                || record.version != 1
                || record.events.len() > record.limits.max_events
            {
                return Err("invalid recording manifest".into());
            }
            let mut last = 0;
            for (index, event) in record.events.iter().enumerate() {
                if event.sequence != index as u64 || event.timestamp_ms < last {
                    return Err("invalid recording sequence".into());
                }
                last = event.timestamp_ms;
                if let Evidence::Frame { sha256, bytes, .. } = &event.evidence {
                    validate_hash(sha256)?;
                    let path = item.path().join(sha256);
                    reject_symlink(&path)?;
                    if *bytes > MAX_FRAME_BYTES || fs::metadata(&path)?.len() != *bytes as u64 {
                        return Err("missing or invalid recording frame".into());
                    }
                }
            }
            // Remove only known temporary/unreferenced content left by interrupted atomic writes.
            let refs: BTreeSet<_> = record
                .events
                .iter()
                .filter_map(|e| match &e.evidence {
                    Evidence::Frame { sha256, .. } => Some(sha256.clone()),
                    _ => None,
                })
                .collect();
            for child in fs::read_dir(item.path())? {
                let child = child?;
                let n = child.file_name().to_string_lossy().to_string();
                reject_symlink(&child.path())?;
                if n == "manifest.tmp" || n == "frame.tmp" || (valid_hash(&n) && !refs.contains(&n))
                {
                    fs::remove_file(child.path())?;
                } else if n != "manifest.json" && !refs.contains(&n) {
                    return Err("unexpected recording file".into());
                }
            }
            if record.active() {
                record.lifecycle(State::Interrupted, Some("process_restart"));
                persist(&root, &record)?;
            }
            if !record.active() && now().saturating_sub(record.updated_at_ms) >= RETENTION_MS {
                let deleted = root.join(format!("deleted_{name}"));
                fs::rename(item.path(), &deleted)?;
                sync_directory(&root)?;
                fs::remove_dir_all(deleted)?;
                sync_directory(&root)?;
                continue;
            }
            records.insert(name, record);
            if records.len() > MAX_RECORDINGS {
                return Err("too many recordings".into());
            }
        }
        if disk_usage(&root)? > MAX_STORE_BYTES {
            return Err("recording store exceeds capacity".into());
        }
        Ok(Self {
            root,
            inner: Mutex::new(Inner { records }),
            _lock: lock,
        })
    }
    fn guard(&self) -> Result<MutexGuard<'_, Inner>, Error> {
        self.inner
            .lock()
            .map_err(|_| "recording store lock poisoned".into())
    }
    /// Applies duration limits even when no capture event is available.
    pub fn active_recording(&self) -> Result<Option<String>, Error> {
        let mut inner = self.guard()?;
        self.expire(&mut inner)?;
        Ok(inner
            .records
            .values()
            .find(|r| r.state == State::Recording)
            .map(|r| r.id.clone()))
    }
    /// Interrupt on Hand shutdown or a capture failure. Reasons are a closed vocabulary.
    pub fn interrupt_active(&self, reason: &str) -> Result<(), Error> {
        if !matches!(
            reason,
            "worker_shutdown"
                | "hand_shutdown"
                | "capture_error"
                | "privacy_unavailable"
                | "permission_denied"
                | "unsupported"
        ) {
            return Err("invalid recording interruption reason".into());
        }
        let mut inner = self.guard()?;
        let id = inner
            .records
            .values()
            .find(|r| r.active())
            .map(|r| r.id.clone());
        if let Some(id) = id {
            let mut record = get(&inner, &id)?.clone();
            record.lifecycle(State::Interrupted, Some(reason));
            self.commit(&mut inner, record)?;
        }
        Ok(())
    }
    /// Returns only an actively recording session and its immutable privacy scope.
    pub fn active_config(&self) -> Result<Option<(String, Scope)>, Error> {
        let mut inner = self.guard()?;
        self.expire(&mut inner)?;
        Ok(inner
            .records
            .values()
            .find(|r| r.state == State::Recording)
            .map(|r| (r.id.clone(), r.scope.clone())))
    }
    // Retention applies only after a terminal transition; active sessions are never pruned.
    fn prune(&self, inner: &mut Inner) -> Result<(), Error> {
        let expired: Vec<_> = inner
            .records
            .values()
            .filter(|r| !r.active() && now().saturating_sub(r.updated_at_ms) >= RETENTION_MS)
            .map(|r| r.id.clone())
            .collect();
        for id in expired {
            let deleted = self.root.join(format!("deleted_{id}"));
            fs::rename(self.root.join(&id), &deleted)?;
            sync_directory(&self.root)?;
            inner.records.remove(&id);
            fs::remove_dir_all(deleted)?;
            sync_directory(&self.root)?;
        }
        Ok(())
    }
    fn expire(&self, inner: &mut Inner) -> Result<(), Error> {
        self.prune(inner)?;
        let ids: Vec<_> = inner
            .records
            .values()
            .filter(|r| {
                r.active() && now().saturating_sub(r.created_at_ms) >= r.limits.max_duration_ms
            })
            .map(|r| r.id.clone())
            .collect();
        for id in ids {
            self.finish(inner, &id, "duration_limit")?;
        }
        Ok(())
    }
    fn finish(&self, inner: &mut Inner, id: &str, reason: &str) -> Result<Value, Error> {
        let mut record = get(inner, id)?.clone();
        record.lifecycle(State::Stopped, Some(reason));
        self.commit(inner, record)
    }
    fn transition(
        &self,
        inner: &mut Inner,
        mut record: Record,
        state: State,
    ) -> Result<Value, Error> {
        if record.events.len() >= record.limits.max_events - 1 {
            return self.finish(inner, &record.id, "event_limit");
        }
        record.lifecycle(state, None);
        if record.events.len() >= record.limits.max_events - 1 {
            record.lifecycle(State::Stopped, Some("event_limit"));
        }
        let size = serde_json::to_vec(&record)?.len() as u64;
        let dir = self.root.join(&record.id);
        if disk_usage(&dir)? - fs::metadata(dir.join("manifest.json"))?.len() + size + 1024
            > record.limits.max_bytes
        {
            return self.finish(inner, &record.id, "storage_limit");
        }
        if disk_usage(&self.root)? + size + 1024 > MAX_STORE_BYTES {
            return self.finish(inner, &record.id, "store_storage_limit");
        }
        self.commit(inner, record)
    }
    fn commit(&self, inner: &mut Inner, record: Record) -> Result<Value, Error> {
        if let Err(error) = persist(&self.root, &record) {
            if let Some(old) = inner.records.get_mut(&record.id) {
                old.state = State::Stopped;
                old.stop_reason = Some("storage_error".into());
            }
            return Err(error);
        }
        let result = record.metadata();
        inner.records.insert(record.id.clone(), record);
        Ok(result)
    }
    pub fn request(&self, value: Value) -> Result<Value, Error> {
        self.execute(serde_json::from_value(value)?)
    }
    pub fn execute(&self, request: Request) -> Result<Value, Error> {
        let mut inner = self.guard()?;
        self.expire(&mut inner)?;
        match request {
            Request::Start { scope, limits } => {
                scope.validate()?;
                if inner.records.values().any(Record::active) {
                    return Err("another recording is active; stop it first".into());
                }
                if inner.records.len() >= MAX_RECORDINGS {
                    return Err("recording count limit reached; delete a recording".into());
                }
                if disk_usage(&self.root)? + 8192 > MAX_STORE_BYTES {
                    return Err("recording store is full".into());
                }
                let limits = limits.unwrap_or_default();
                limits.validate()?;
                let id = format!("rec_{}", uuid::Uuid::new_v4().simple());
                let t = now();
                let record = Record {
                    version: 1,
                    id: id.clone(),
                    state: State::Recording,
                    stop_reason: None,
                    created_at_ms: t,
                    updated_at_ms: t,
                    limits,
                    scope,
                    events: vec![],
                };
                if serde_json::to_vec(&record)?.len() as u64 + 1024 > record.limits.max_bytes {
                    return Err("recording scope exceeds storage limit".into());
                }
                private_dir(&self.root.join(&id))?;
                self.commit(&mut inner, record)
            }
            Request::Pause { id } => {
                let record = get(&inner, &id)?.clone();
                if record.state != State::Recording {
                    return Err("only a recording session can be paused".into());
                }
                self.transition(&mut inner, record, State::Paused)
            }
            Request::Resume { id } => {
                let record = get(&inner, &id)?.clone();
                if record.state != State::Paused {
                    return Err("only a paused session can be resumed; interrupted recordings require a new start".into());
                }
                self.transition(&mut inner, record, State::Recording)
            }
            Request::Stop { id } => {
                let record = get(&inner, &id)?;
                if !record.active() {
                    return Ok(record.metadata());
                }
                self.finish(&mut inner, &id, "user_stop")
            }
            Request::Status { id } => match id {
                Some(id) => Ok(get(&inner, &id)?.metadata()),
                None => Ok(inner
                    .records
                    .values()
                    .find(|r| r.active())
                    .map(Record::metadata)
                    .unwrap_or(json!({"state":"idle"}))),
            },
            Request::List { cursor, limit } => {
                let (offset, limit) = page(cursor, limit, 50, inner.records.len())?;
                let rows: Vec<_> = inner
                    .records
                    .values()
                    .skip(offset)
                    .take(limit)
                    .map(Record::metadata)
                    .collect();
                let next = offset + rows.len();
                Ok(
                    json!({"recordings":rows,"next_cursor":if next<inner.records.len(){Some(next)}else{None}}),
                )
            }
            Request::Read { id, cursor, limit } | Request::Export { id, cursor, limit } => {
                let record = get(&inner, &id)?;
                let (offset, limit) = page(cursor, limit, 200, record.events.len())?;
                let end = (offset + limit).min(record.events.len());
                Ok(
                    json!({"format":"nanocodex-recording-v1","recording":record.metadata(),"events":&record.events[offset..end],"next_cursor":if end<record.events.len(){Some(end)}else{None},"frames":"retrieve each referenced sha256 with operation=frame and this recording id"}),
                )
            }
            Request::Frame {
                id,
                sha256,
                offset,
                length,
            } => {
                validate_hash(&sha256)?;
                let record = get(&inner, &id)?;
                let expected = record
                    .events
                    .iter()
                    .find_map(|entry| match &entry.evidence {
                        Evidence::Frame {
                            sha256: hash,
                            bytes,
                            mime,
                            ..
                        } if hash == &sha256 => Some((*bytes, mime)),
                        _ => None,
                    })
                    .ok_or("frame is not referenced by recording")?;
                let path = self.root.join(&id).join(&sha256);
                reject_symlink(&path)?;
                if fs::metadata(&path)?.len() > MAX_FRAME_BYTES as u64 {
                    return Err("frame exceeds safety bound".into());
                }
                let bytes = fs::read(path)?;
                if bytes.len() != expected.0 || hash(&bytes) != sha256 {
                    return Err("frame integrity check failed".into());
                }
                let start = offset.unwrap_or(0);
                let length = length.unwrap_or(375_000);
                if start > bytes.len() || length == 0 || length > 375_000 {
                    return Err("invalid frame range".into());
                }
                let end = (start + length).min(bytes.len());
                Ok(
                    json!({"id":id,"sha256":sha256,"mime":expected.1,"bytes":bytes.len(),"offset":start,"length":end-start,"next_cursor":if end<bytes.len(){Some(end)}else{None},"data_base64":STANDARD.encode(&bytes[start..end])}),
                )
            }
            Request::Delete { id } => {
                if get(&inner, &id)?.active() {
                    return Err("stop recording before deleting it".into());
                }
                let deleted = self.root.join(format!("deleted_{id}"));
                fs::rename(self.root.join(&id), &deleted)?;
                sync_directory(&self.root)?;
                inner.records.remove(&id);
                fs::remove_dir_all(deleted)?;
                sync_directory(&self.root)?;
                Ok(json!({"id":id,"deleted":true}))
            }
        }
    }
    pub fn append_event(&self, id: &str, event: SafeEvent) -> Result<Value, Error> {
        self.append_event_from(id, event, Source::Unknown)
    }
    /// Use Human or Agent only when the caller has direct evidence of that origin.
    pub fn append_event_from(
        &self,
        id: &str,
        event: SafeEvent,
        source: Source,
    ) -> Result<Value, Error> {
        match &event {
            SafeEvent::Focus { app_id, window_id } => {
                validate_context_id(app_id, true)?;
                validate_context_id(window_id, false)?;
            }
            SafeEvent::Suppressed { reason }
                if !matches!(
                    reason.as_str(),
                    "scope_excluded"
                        | "frame_provider_unavailable"
                        | "secure_input"
                        | "secure_input_unknown"
                        | "native_observation_unavailable"
                        | "capture_suppressed"
                        | "capture_failed"
                        | "capture_unsupported"
                ) =>
            {
                return Err("invalid suppression reason".into());
            }
            _ => {}
        }
        self.append(id, Evidence::Input { event }, None, source)
    }
    pub fn append_frame(&self, id: &str, frame: FilteredFrame<'_>) -> Result<Value, Error> {
        if frame.bytes.len() > MAX_FRAME_BYTES {
            let mut inner = self.guard()?;
            if get(&inner, id)?.state != State::Recording {
                return Err("recording is not accepting evidence".into());
            }
            return self.finish(&mut inner, id, "frame_size_limit");
        }
        if frame.bytes.is_empty()
            || frame.width == 0
            || frame.height == 0
            || frame.width > 16384
            || frame.height > 16384
        {
            return Err("invalid frame dimensions or bytes".into());
        }
        self.append(
            id,
            Evidence::Frame {
                sha256: hash(frame.bytes),
                bytes: frame.bytes.len(),
                width: frame.width,
                height: frame.height,
                mime: frame.mime,
            },
            Some(frame.bytes),
            Source::Unknown,
        )
    }
    fn append(
        &self,
        id: &str,
        evidence: Evidence,
        bytes: Option<&[u8]>,
        source: Source,
    ) -> Result<Value, Error> {
        let mut inner = self.guard()?;
        self.expire(&mut inner)?;
        let mut record = get(&inner, id)?.clone();
        if record.state != State::Recording {
            return Err("recording is not accepting evidence".into());
        }
        // Unchanged consecutive samples carry no new evidence. After another event,
        // a repeated frame remains a useful temporal reference to the existing blob.
        if let (
            Some(Entry {
                evidence:
                    Evidence::Frame {
                        sha256: previous, ..
                    },
                ..
            }),
            Evidence::Frame {
                sha256: current, ..
            },
        ) = (record.events.last(), &evidence)
            && previous == current
        {
            return Ok(record.metadata());
        }
        if record.events.len() >= record.limits.max_events - 1 {
            return self.finish(&mut inner, id, "event_limit");
        }
        let timestamp = now().max(record.updated_at_ms);
        record.events.push(Entry {
            sequence: record.events.len() as u64,
            timestamp_ms: timestamp,
            source,
            evidence,
        });
        record.updated_at_ms = timestamp;
        let frame_path = match &record.events.last().ok_or("missing evidence")?.evidence {
            Evidence::Frame { sha256, .. } => Some(self.root.join(id).join(sha256)),
            _ => None,
        };
        let extra = match &frame_path {
            Some(path) => {
                reject_symlink(path)?;
                if path.exists() {
                    0
                } else {
                    bytes.map_or(0, |b| b.len()) as u64
                }
            }
            None => 0,
        };
        let manifest_size = serde_json::to_vec(&record)?.len() as u64;
        let dir = self.root.join(id);
        let old_size = fs::metadata(dir.join("manifest.json"))?.len();
        let record_size = disk_usage(&dir)? - old_size + manifest_size + extra;
        // Reserve room for the terminal reason and atomic manifest replacement.
        if record_size + 1024 > record.limits.max_bytes {
            return self.finish(&mut inner, id, "storage_limit");
        }
        if disk_usage(&self.root)? + manifest_size + extra + 1024 > MAX_STORE_BYTES {
            return self.finish(&mut inner, id, "store_storage_limit");
        }
        if let (Some(path), Some(bytes)) = (frame_path, bytes) {
            if !path.exists() {
                let tmp = dir.join("frame.tmp");
                let written = (|| -> Result<(), Error> {
                    let mut file = private_file(&tmp, false)?;
                    file.set_len(0)?;
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    drop(file);
                    fs::rename(&tmp, &path)?;
                    sync_directory(&dir)
                })();
                if let Err(error) = written {
                    let _ = fs::remove_file(tmp);
                    let _ = self.finish(&mut inner, id, "storage_error");
                    return Err(error);
                }
            } else if fs::metadata(&path)?.len() != bytes.len() as u64 || fs::read(&path)? != bytes
            {
                let _ = self.finish(&mut inner, id, "storage_error");
                return Err("existing frame failed integrity check".into());
            }
        }
        // Stop at the boundary, without requiring an extra sample to discover the limit.
        if record.events.len() >= record.limits.max_events - 1 {
            record.lifecycle(State::Stopped, Some("event_limit"));
        }
        self.commit(&mut inner, record)
    }
}
fn get<'a>(inner: &'a Inner, id: &str) -> Result<&'a Record, Error> {
    validate_id(id)?;
    inner
        .records
        .get(id)
        .ok_or_else(|| "recording not found".into())
}
fn page(
    cursor: Option<usize>,
    limit: Option<usize>,
    cap: usize,
    total: usize,
) -> Result<(usize, usize), Error> {
    let offset = cursor.unwrap_or(0);
    let limit = limit.unwrap_or(cap);
    if limit == 0 || limit > cap || offset > total {
        return Err("invalid pagination bounds".into());
    }
    Ok((offset, limit))
}
fn validate_id(id: &str) -> Result<(), Error> {
    if id.len() != 36
        || !id.starts_with("rec_")
        || !id[4..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("invalid recording id".into());
    }
    Ok(())
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn validate_hash(hash: &str) -> Result<(), Error> {
    if !valid_hash(hash) {
        return Err("invalid frame hash".into());
    }
    Ok(())
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn reject_symlink(path: &Path) -> Result<(), Error> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err("symlinks are not allowed in recording storage".into())
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn private_dir(path: &Path) -> Result<(), Error> {
    reject_symlink(path)?;
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn private_file(path: &Path, new: bool) -> Result<File, Error> {
    reject_symlink(path)?;
    let mut options = OpenOptions::new();
    options.write(true).read(true);
    if new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}
fn persist(root: &Path, record: &Record) -> Result<(), Error> {
    let dir = root.join(&record.id);
    let tmp = dir.join("manifest.tmp");
    let mut file = private_file(&tmp, false)?;
    file.set_len(0)?;
    file.write_all(&serde_json::to_vec(record)?)?;
    file.sync_all()?;
    drop(file);
    let target = dir.join("manifest.json");
    reject_symlink(&target)?;
    fs::rename(tmp, target)?;
    sync_directory(&dir)?;
    sync_directory(root)?;
    Ok(())
}
fn sync_directory(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
fn disk_usage(path: &Path) -> Result<u64, Error> {
    let mut bytes = 0u64;
    for child in fs::read_dir(path)? {
        let child = child?;
        let meta = child.file_type()?;
        if meta.is_symlink() {
            return Err("symlinks are not allowed in recording storage".into());
        }
        bytes = bytes
            .checked_add(if meta.is_dir() {
                disk_usage(&child.path())?
            } else {
                child.metadata()?.len()
            })
            .ok_or("recording storage size overflow")?;
    }
    Ok(bytes)
}

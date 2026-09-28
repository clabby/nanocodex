//! Persistent model-context sequences. Pages reference immutable message records;
//! a new model boundary publishes only new messages and changed tail pages.

use crate::{EncodedPayload, Result, StoreRecord, session::DurableOwner};
use nanocodex_agent::{
    execution::{ExecutionContinuation, ResponseHistory, ResponseItem},
    session::{SessionSnapshot, SessionSnapshotHead},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Copy)]
pub(crate) enum Reader<'a> {
    Owner(&'a DurableOwner),
    Session(&'a crate::DurableSession),
}
impl<'a> From<&'a DurableOwner> for Reader<'a> {
    fn from(value: &'a DurableOwner) -> Self {
        Self::Owner(value)
    }
}
impl<'a> From<&'a crate::DurableSession> for Reader<'a> {
    fn from(value: &'a crate::DurableSession) -> Self {
        Self::Session(value)
    }
}
impl Reader<'_> {
    async fn load_payloads(self, payloads: Vec<EncodedPayload>) -> Result<Vec<EncodedPayload>> {
        match self {
            Self::Owner(owner) => owner.load_payloads(payloads).await,
            Self::Session(session) => session.resolve_many(payloads).await,
        }
    }

    async fn load_payload(self, payload: EncodedPayload) -> Result<EncodedPayload> {
        match self {
            Self::Owner(owner) => owner.load_payload(payload).await,
            Self::Session(session) => session.resolve(&payload).await,
        }
    }
}

const PAGE_ITEMS: usize = 64;

#[derive(Clone, Default, Deserialize, Serialize)]
struct Sequence {
    tail: Option<EncodedPayload>,
}

#[derive(Deserialize, Serialize)]
struct Page {
    previous: Option<EncodedPayload>,
    items: Vec<EncodedPayload>,
}

#[derive(Deserialize, Serialize)]
struct Continuation {
    state: Box<RawValue>,
    history: Sequence,
    prefix: Sequence,
}

/// Record keys of one committed page: its own key and its items' keys.
type PageKeys = Arc<(Arc<str>, Vec<Arc<str>>)>;

/// Acknowledged, immutable context records. The last acknowledged continuation
/// is held, not just its addresses, so allocation identity proves content.
#[derive(Default)]
pub(crate) struct ContextCache {
    pub(crate) known: HashSet<Arc<str>>,
    history: Option<(ResponseHistory, Vec<PageKeys>)>,
    prefix: Option<(Arc<[ResponseItem]>, Vec<PageKeys>)>,
}

impl ContextCache {
    /// Merges the delta of an acknowledged commit or a loaded continuation.
    pub(crate) fn extend(&mut self, delta: Self) {
        self.known.extend(delta.known);
        if delta.history.is_some() {
            (self.history, self.prefix) = (delta.history, delta.prefix);
        }
    }
}

/// Prepared immutable writes. The cache is advanced only after a successful commit.
pub(crate) struct Prepared {
    pub(crate) payload: EncodedPayload,
    pub(crate) delta: ContextCache,
}

struct Writer<'a> {
    known: &'a HashSet<Arc<str>>,
    keys: HashSet<Arc<str>>,
    records: Vec<StoreRecord>,
}

fn tail(pages: &[PageKeys]) -> Sequence {
    let tail = pages.last();
    Sequence {
        tail: tail.map(|page| EncodedPayload::reference_key(page.0.clone())),
    }
}

impl<'a> Writer<'a> {
    fn new(known: &'a HashSet<Arc<str>>) -> Self {
        Self {
            known,
            keys: HashSet::new(),
            records: Vec::new(),
        }
    }

    fn record<T: Serialize>(&mut self, value: &T) -> Result<Arc<str>> {
        let mut payload = EncodedPayload::encode(value)?;
        if !self.known.contains(&payload.key) && self.keys.insert(payload.key.clone()) {
            payload.stage(&mut self.records);
        }
        Ok(payload.key)
    }

    /// Encodes `items` after the first `shared` items of `cached`. Later pages
    /// are re-encoded because each page names its predecessor.
    fn sequence<'i, T: Serialize + 'i>(
        &mut self,
        items: impl IntoIterator<Item = &'i T>,
        cached: &[PageKeys],
        shared: usize,
    ) -> Result<Vec<PageKeys>> {
        let mut pages = cached[..shared / PAGE_ITEMS].to_vec();
        let mut current = cached
            .get(shared / PAGE_ITEMS)
            .map_or_else(Vec::new, |page| page.1[..shared % PAGE_ITEMS].to_vec());
        for item in items {
            current.push(self.record(item)?);
            if current.len() == PAGE_ITEMS {
                self.page(&mut pages, std::mem::take(&mut current))?;
            }
        }
        if !current.is_empty() {
            self.page(&mut pages, current)?;
        }
        Ok(pages)
    }

    fn page(&mut self, pages: &mut Vec<PageKeys>, items: Vec<Arc<str>>) -> Result<()> {
        let key = self.record(&Page {
            previous: tail(pages).tail,
            items: items
                .iter()
                .cloned()
                .map(EncodedPayload::reference_key)
                .collect(),
        })?;
        pages.push(Arc::new((key, items)));
        Ok(())
    }

    fn finish<T: Serialize>(self, value: &T) -> Result<Prepared> {
        Ok(Prepared {
            payload: EncodedPayload::encode(value)?.with_records(self.records),
            delta: ContextCache {
                known: self.keys,
                ..ContextCache::default()
            },
        })
    }
}

/// Encodes a model boundary, re-encoding only items after the prefix it
/// provably shares with the last acknowledged boundary.
pub(crate) fn prepare_continuation(
    value: ExecutionContinuation,
    cache: &ContextCache,
) -> Result<Prepared> {
    let mut writer = Writer::new(&cache.known);
    let (shared, cached) = match &cache.history {
        Some((previous, pages)) => (value.history.shared_prefix_len(previous), &pages[..]),
        None => (0, &[][..]),
    };
    let history = writer.sequence(value.history.iter_from(shared), cached, shared)?;
    let prefix = match &cache.prefix {
        Some((previous, pages)) if Arc::ptr_eq(previous, &value.prefix) => pages.clone(),
        _ => writer.sequence(value.prefix.iter(), &[], 0)?,
    };
    let state = RawValue::from_string(value.state_json).map_err(crate::Error::InvalidPayload)?;
    let mut prepared = writer.finish(&Continuation {
        state,
        history: tail(&history),
        prefix: tail(&prefix),
    })?;
    prepared.delta.history = Some((value.history, history));
    prepared.delta.prefix = Some((value.prefix, prefix));
    Ok(prepared)
}

async fn load_sequence<T: serde::de::DeserializeOwned>(
    owner: Reader<'_>,
    sequence: Sequence,
    keys: &mut HashSet<Arc<str>>,
) -> Result<(Vec<T>, Vec<PageKeys>)> {
    let mut pages = Vec::new();
    let mut next = sequence.tail;
    while let Some(reference) = next {
        let key = reference.key.clone();
        let page: Page = owner.load_payload(reference).await?.decode()?;
        next = page.previous;
        pages.push((key, page.items));
    }
    let mut items = Vec::new();
    let mut page_keys = Vec::new();
    for (key, page) in pages.into_iter().rev() {
        for chunk in page.chunks(16) {
            for payload in owner.load_payloads(chunk.to_vec()).await? {
                items.push(payload.decode()?);
            }
        }
        let page: Vec<_> = page.into_iter().map(|reference| reference.key).collect();
        keys.extend(page.iter().cloned());
        keys.insert(key.clone());
        page_keys.push(Arc::new((key, page)));
    }
    Ok((items, page_keys))
}

/// Loads a continuation and the cache delta that seeds incremental writes.
pub(crate) async fn load_continuation(
    owner: Reader<'_>,
    payload: EncodedPayload,
) -> Result<(ExecutionContinuation, ContextCache)> {
    let value: Continuation = payload.decode()?;
    let mut known = HashSet::new();
    let (history, history_pages) = load_sequence(owner, value.history, &mut known).await?;
    let (prefix, prefix_pages) = load_sequence(owner, value.prefix, &mut known).await?;
    let history = ResponseHistory::new(history);
    let prefix: Arc<[ResponseItem]> = Arc::from(prefix);
    let continuation = ExecutionContinuation {
        state_json: value.state.get().to_owned(),
        history: history.clone(),
        prefix: Arc::clone(&prefix),
    };
    let delta = ContextCache {
        known,
        history: Some((history, history_pages)),
        prefix: Some((prefix, prefix_pages)),
    };
    Ok((continuation, delta))
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Snapshot {
    head: SessionSnapshotHead,
    history: Sequence,
    prefix: Option<Sequence>,
}

pub(crate) fn prepare_snapshot(value: SessionSnapshot, cache: &ContextCache) -> Result<Prepared> {
    let (head, history, prefix) = value.into_context_parts();
    let mut writer = Writer::new(&cache.known);
    let mut sequence = |items: Vec<_>| writer.sequence(&items, &[], 0).map(|pages| tail(&pages));
    let history = sequence(history)?;
    let prefix = prefix.map(sequence).transpose()?;
    writer.finish(&Snapshot {
        head,
        history,
        prefix,
    })
}

pub(crate) async fn load_snapshot(
    owner: Reader<'_>,
    payload: EncodedPayload,
) -> Result<SessionSnapshot> {
    restore_snapshot(owner, payload.decode()?).await
}

pub(crate) async fn restore_snapshot(
    owner: Reader<'_>,
    saved: Snapshot,
) -> Result<SessionSnapshot> {
    load_snapshot_with_keys(owner, saved)
        .await
        .map(|(snapshot, _)| snapshot)
}

pub(crate) async fn load_snapshot_with_keys(
    owner: Reader<'_>,
    saved: Snapshot,
) -> Result<(SessionSnapshot, HashSet<Arc<str>>)> {
    let mut keys = HashSet::new();
    let history = load_sequence(owner, saved.history, &mut keys).await?.0;
    let prefix = match saved.prefix {
        Some(value) => Some(load_sequence(owner, value, &mut keys).await?.0),
        None => None,
    };
    Ok((saved.head.with_context(history, prefix), keys))
}

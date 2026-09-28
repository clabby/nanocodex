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

/// Borrowed encoding of [`Page`]; both serialize to the same bytes, so page
/// keys stay stable across the incremental and full writers.
#[derive(Serialize)]
struct PageRef<'a> {
    previous: Option<&'a str>,
    items: Vec<&'a str>,
}

#[derive(Deserialize, Serialize)]
struct Continuation {
    state: Box<RawValue>,
    history: Sequence,
    prefix: Sequence,
}

/// Record keys of one committed page.
struct PageKeys {
    key: Arc<str>,
    items: Vec<Arc<str>>,
}

/// Record keys of one committed page sequence, in item order.
#[derive(Clone, Default)]
struct SequenceKeys {
    pages: Vec<Arc<PageKeys>>,
}

impl SequenceKeys {
    fn len(&self) -> usize {
        self.pages.last().map_or(0, |page| {
            (self.pages.len() - 1) * PAGE_ITEMS + page.items.len()
        })
    }

    fn sequence(&self) -> Sequence {
        Sequence {
            tail: self
                .pages
                .last()
                .map(|page| EncodedPayload::reference_key(page.key.clone())),
        }
    }
}

/// Memo of context records already durable in one state.
///
/// Records are immutable and never deleted, so every key here stays valid for
/// the owner's lifetime. The cached sources are held (not just their
/// addresses) so pointer identity keeps proving content identity: a retained
/// `Arc` cannot be freed and reused, and a shared tail cannot be mutated in
/// place. Entries change only after the store acknowledged a commit.
#[derive(Default)]
pub(crate) struct ContextCache {
    known: HashSet<Arc<str>>,
    history: Option<(ResponseHistory, SequenceKeys)>,
    prefix: Option<(Arc<[ResponseItem]>, SequenceKeys)>,
}

/// Prepared immutable writes. The cache is advanced only after a successful commit.
pub(crate) struct Prepared {
    payload: EncodedPayload,
    update: CacheUpdate,
}

struct CacheUpdate {
    staged: HashSet<Arc<str>>,
    history: Option<(ResponseHistory, SequenceKeys)>,
    prefix: Option<(Arc<[ResponseItem]>, SequenceKeys)>,
}

impl ContextCache {
    pub(crate) fn with_known(known: HashSet<Arc<str>>) -> Self {
        Self {
            known,
            ..Self::default()
        }
    }

    /// Encodes a model boundary, re-encoding only items after the prefix the
    /// last committed boundary provably shares by allocation identity.
    pub(crate) fn prepare_continuation(&self, value: ExecutionContinuation) -> Result<Prepared> {
        let mut writer = Writer::new(&self.known);
        let history = match &self.history {
            Some((source, keys)) => {
                let shared = value.history.shared_prefix_len(source);
                debug_assert!(shared <= keys.len());
                writer.sequence(value.history.iter_from(shared), keys, shared)?
            }
            None => writer.sequence(value.history.iter(), &SequenceKeys::default(), 0)?,
        };
        let prefix = match &self.prefix {
            Some((source, keys)) if Arc::ptr_eq(source, &value.prefix) => keys.clone(),
            _ => writer.sequence(value.prefix.iter(), &SequenceKeys::default(), 0)?,
        };
        let state =
            RawValue::from_string(value.state_json).map_err(crate::Error::InvalidPayload)?;
        let payload = writer.finish(&Continuation {
            state,
            history: history.sequence(),
            prefix: prefix.sequence(),
        })?;
        Ok(Prepared {
            payload,
            update: CacheUpdate {
                staged: writer.staged,
                history: Some((value.history, history)),
                prefix: Some((value.prefix, prefix)),
            },
        })
    }

    pub(crate) fn prepare_snapshot(&self, value: SessionSnapshot) -> Result<Prepared> {
        let (head, history, prefix) = value.into_context_parts();
        let mut writer = Writer::new(&self.known);
        let empty = SequenceKeys::default();
        let history = writer.sequence(history.iter(), &empty, 0)?.sequence();
        let prefix = prefix
            .map(|items| writer.sequence(items.iter(), &empty, 0))
            .transpose()?
            .map(|keys| keys.sequence());
        let payload = writer.finish(&Snapshot {
            head,
            history,
            prefix,
        })?;
        Ok(Prepared {
            payload,
            update: CacheUpdate {
                staged: writer.staged,
                history: None,
                prefix: None,
            },
        })
    }

    /// Records a commit the store acknowledged.
    pub(crate) fn committed(&mut self, committed: CommittedContext) {
        let update = committed.0;
        self.known.extend(update.staged);
        if update.history.is_some() {
            self.history = update.history;
        }
        if update.prefix.is_some() {
            self.prefix = update.prefix;
        }
    }

    /// Adopts a continuation loaded from the store as the committed baseline.
    pub(crate) fn loaded(&mut self, loaded: LoadedContinuation) {
        self.known.extend(loaded.keys);
        self.history = Some(loaded.history);
        self.prefix = Some(loaded.prefix);
    }
}

impl Prepared {
    /// Splits the payload to publish from the cache update to apply after
    /// the store acknowledges it.
    pub(crate) fn into_parts(self) -> (EncodedPayload, CommittedContext) {
        (self.payload, CommittedContext(self.update))
    }
}

/// Cache update that becomes valid only after its payload committed.
pub(crate) struct CommittedContext(CacheUpdate);

struct Writer<'a> {
    known: &'a HashSet<Arc<str>>,
    staged: HashSet<Arc<str>>,
    records: Vec<StoreRecord>,
}

impl<'a> Writer<'a> {
    fn new(known: &'a HashSet<Arc<str>>) -> Self {
        Self {
            known,
            staged: HashSet::new(),
            records: Vec::new(),
        }
    }

    fn record<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<Arc<str>> {
        let mut payload = EncodedPayload::encode(value)?;
        let key = payload.key.clone();
        if !self.known.contains(&key) && self.staged.insert(key.clone()) {
            payload.stage(&mut self.records);
        }
        Ok(key)
    }

    /// Encodes `items`, which continue after the first `shared` items of the
    /// committed `cached` sequence. Complete pages inside the shared prefix
    /// keep their keys; pages from the first touched page onward are
    /// re-encoded because each page names its predecessor.
    fn sequence<'i, T: Serialize + 'i>(
        &mut self,
        items: impl Iterator<Item = &'i T>,
        cached: &SequenceKeys,
        shared: usize,
    ) -> Result<SequenceKeys> {
        let first_dirty = shared / PAGE_ITEMS;
        let mut pages = cached.pages[..first_dirty].to_vec();
        let mut current = cached
            .pages
            .get(first_dirty)
            .map(|page| page.items[..shared - first_dirty * PAGE_ITEMS].to_vec())
            .unwrap_or_default();
        for item in items {
            current.push(self.record(item)?);
            if current.len() == PAGE_ITEMS {
                self.page(&mut pages, std::mem::take(&mut current))?;
            }
        }
        if !current.is_empty() {
            self.page(&mut pages, current)?;
        }
        Ok(SequenceKeys { pages })
    }

    fn page(&mut self, pages: &mut Vec<Arc<PageKeys>>, items: Vec<Arc<str>>) -> Result<()> {
        let key = self.record(&PageRef {
            previous: pages.last().map(|page| &*page.key),
            items: items.iter().map(|key| &**key).collect(),
        })?;
        pages.push(Arc::new(PageKeys { key, items }));
        Ok(())
    }

    fn finish<T: Serialize>(&mut self, value: &T) -> Result<EncodedPayload> {
        Ok(EncodedPayload::encode(value)?.with_records(std::mem::take(&mut self.records)))
    }
}

async fn load_sequence<T: serde::de::DeserializeOwned>(
    owner: Reader<'_>,
    sequence: Sequence,
    known: &mut HashSet<Arc<str>>,
) -> Result<(Vec<T>, SequenceKeys)> {
    let mut pages = Vec::new();
    let mut next = sequence.tail;
    while let Some(reference) = next {
        let key = reference.key.clone();
        let page: Page = owner.load_payload(reference).await?.decode()?;
        next = page.previous;
        known.insert(key.clone());
        pages.push((key, page.items));
    }
    let mut items = Vec::new();
    let mut keys = SequenceKeys::default();
    for (key, page) in pages.into_iter().rev() {
        for chunk in page.chunks(16) {
            for payload in owner.load_payloads(chunk.to_vec()).await? {
                items.push(payload.decode()?);
            }
        }
        let page = page
            .into_iter()
            .map(|reference| reference.key)
            .collect::<Vec<_>>();
        known.extend(page.iter().cloned());
        keys.pages.push(Arc::new(PageKeys { key, items: page }));
    }
    Ok((items, keys))
}

/// A continuation restored from the store with the record keys that prove it.
pub(crate) struct LoadedContinuation {
    keys: HashSet<Arc<str>>,
    history: (ResponseHistory, SequenceKeys),
    prefix: (Arc<[ResponseItem]>, SequenceKeys),
}

pub(crate) async fn load_continuation(
    owner: Reader<'_>,
    payload: EncodedPayload,
) -> Result<(ExecutionContinuation, LoadedContinuation)> {
    let value: Continuation = payload.decode()?;
    let mut keys = HashSet::new();
    let (history, history_keys) = load_sequence(owner, value.history, &mut keys).await?;
    let (prefix, prefix_keys) =
        load_sequence::<ResponseItem>(owner, value.prefix, &mut keys).await?;
    let history = ResponseHistory::new(history);
    let prefix: Arc<[ResponseItem]> = prefix.into();
    let continuation = ExecutionContinuation {
        state_json: value.state.get().to_owned(),
        history: history.clone(),
        prefix: Arc::clone(&prefix),
    };
    Ok((
        continuation,
        LoadedContinuation {
            keys,
            history: (history, history_keys),
            prefix: (prefix, prefix_keys),
        },
    ))
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Snapshot {
    head: SessionSnapshotHead,
    history: Sequence,
    prefix: Option<Sequence>,
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
    let (history, _) = load_sequence(owner, saved.history, &mut keys).await?;
    let prefix = match saved.prefix {
        Some(value) => Some(load_sequence(owner, value, &mut keys).await?.0),
        None => None,
    };
    Ok((saved.head.with_context(history, prefix), keys))
}

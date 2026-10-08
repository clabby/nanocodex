//! Durable subagent task-tree journal beside a root's execution state.
//!
//! Every durability adapter attaches this to its builder, so any harness whose
//! root is durable also exposes a durable task tree on its handle, and a
//! subagent registry needs no host-specific wiring.

use std::sync::Arc;

use nanocodex_agent::backend::{BackendFuture, ChildJournal, ChildJournalStore};

use crate::{
    StateStore,
    shared_store::SharedStore,
    store::{OwnerId, OwnerToken},
};

struct Fenced {
    store: SharedStore,
    owner: Option<(OwnerToken, u64)>,
}

struct Inner {
    state_id: String,
    fenced: tokio::sync::Mutex<Fenced>,
}

impl Inner {
    async fn acquire(&self, fenced: &mut Fenced) -> std::io::Result<Option<String>> {
        let owned = fenced
            .store
            .acquire(&self.state_id, OwnerId::new())
            .await
            .map_err(std::io::Error::other)?;
        fenced.owner = Some((owned.owner, owned.state.revision));
        Ok(owned.state.payload)
    }
}

#[derive(Clone)]
struct SharedJournal(Arc<Inner>);

impl ChildJournalStore for SharedJournal {
    fn load(&self) -> BackendFuture<std::io::Result<Option<String>>> {
        let inner = Arc::clone(&self.0);
        Box::pin(async move {
            let mut fenced = inner.fenced.lock().await;
            inner.acquire(&mut fenced).await
        })
    }

    fn save(&self, payload: String) -> BackendFuture<std::io::Result<()>> {
        let inner = Arc::clone(&self.0);
        Box::pin(async move {
            let mut fenced = inner.fenced.lock().await;
            if fenced.owner.is_none() {
                inner.acquire(&mut fenced).await?;
            }
            let (owner, revision) = fenced
                .owner
                .clone()
                .ok_or_else(|| std::io::Error::other("journal owner was not acquired"))?;
            // A newer runtime acquiring this journal fences this writer.
            let revision = fenced
                .store
                .replace(&inner.state_id, &owner, revision, &payload, &[])
                .await
                .map_err(std::io::Error::other)?;
            fenced.owner = Some((owner, revision));
            Ok(())
        })
    }
}

/// The task-tree journal of the durable root stored as `root_state_id`.
pub(crate) fn child_journal(store: SharedStore, root_state_id: &str) -> ChildJournal {
    ChildJournal::new(Arc::new(SharedJournal(Arc::new(Inner {
        state_id: format!("{root_state_id}:subagents"),
        fenced: tokio::sync::Mutex::new(Fenced { store, owner: None }),
    }))))
}

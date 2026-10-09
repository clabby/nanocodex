//! The local (`ncl`, `nanocodex --local`) backend of the unified TUI.
//!
//! Local mode reuses the managed driver unchanged: [`LocalState::connect`]
//! builds the in-process agent and returns the same pieces `connect_agent`
//! returns for a managed session, with the agent event stream bridged into
//! managed events by [`events`].

pub(crate) mod agent;
pub(crate) mod control;
pub(crate) mod events;
pub(crate) mod sessions;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
};

use nanocodex::{HarnessModel, Nanocodex};
use nanocodex_managed::{AgentSettings, ManagedEvent, ManagedModel};
use tokio::{sync::mpsc, task::JoinHandle};

use self::agent::{LocalBackend, LocalLaunch};
use super::{
    backend::Capabilities,
    features::{ContextBase, FeatureContext, Features},
};

type Slot = Arc<Mutex<Option<(LocalBackend, JoinHandle<()>)>>>;

/// Everything the driver keeps for a local session.
pub(crate) struct LocalState {
    pub(crate) launch: LocalLaunch,
    pub(crate) backend: Option<LocalBackend>,
    bridge: Option<JoinHandle<()>>,
    slot: Slot,
    pub(crate) submissions: events::Submissions,
    pub(crate) features: Features,
    pub(crate) prompted: bool,
    pub(crate) busy: bool,
}

/// What a successful local connection hands to the driver.
pub(crate) struct LocalConnection {
    pub(crate) agent: Nanocodex,
    pub(crate) events: mpsc::UnboundedReceiver<ManagedEvent>,
    pub(crate) session_id: String,
    pub(crate) workspace: PathBuf,
    pub(crate) settings: AgentSettings,
    /// Replayed history of a resumed session (empty for a fresh one).
    pub(in crate::nanocodex2::tui) history: super::history::HistoryWindow,
}

impl LocalConnection {
    /// The pieces the driver's connection result carries.
    pub(super) fn into_connected(self) -> super::ConnectedAgent {
        (
            self.agent,
            self.events,
            self.session_id,
            self.workspace,
            self.history,
            None,
            self.settings,
            true,
            super::ManagedActiveTurns::default(),
        )
    }
}

impl super::DriverRuntime {
    /// Rebuilds the local agent for a saved session (/attach) or, with
    /// `session: None`, a fresh one. The running agent keeps serving until the
    /// replacement connects.
    pub(super) fn local_relaunch(
        &mut self,
        purpose: super::ConnectionPurpose,
        session: Option<&str>,
    ) -> Result<tokio::task::AbortHandle, String> {
        let Some(local) = self.local.as_mut() else {
            return Err("no local session".to_owned());
        };
        let Some(id) = session.map(str::to_owned) else {
            let launch = sessions::fresh(&local.launch);
            return self.local_switch(purpose, launch);
        };
        // Finding and validating the saved session reads the disk: do it in the task.
        let connecting = local.connect_with(move |base| {
            sessions::relaunch(&base, &id).map_err(|error| format!("{error:#}"))
        });
        Ok(self.spawn_local_connection(purpose, connecting))
    }

    fn spawn_local_connection(
        &mut self,
        purpose: super::ConnectionPurpose,
        connecting: impl std::future::Future<Output = Result<LocalConnection, String>> + Send + 'static,
    ) -> tokio::task::AbortHandle {
        self.connection.spawn(async move {
            super::ConnectionResult::Agent {
                purpose,
                result: connecting
                    .await
                    .map(LocalConnection::into_connected)
                    .map_err(|error| super::ConnectionFailure {
                        error: nanocodex_managed::ManagedError::Configuration(error),
                        retry: super::RetryTarget::Default,
                    }),
            }
        })
    }

    /// Replaces the local agent with one built from `launch` (branch switch/edit).
    pub(super) fn local_switch(
        &mut self,
        purpose: super::ConnectionPurpose,
        launch: agent::LocalLaunch,
    ) -> Result<tokio::task::AbortHandle, String> {
        let Some(local) = self.local.as_mut() else {
            return Err("no local session".to_owned());
        };
        local.launch = launch;
        let connecting = local.connect();
        Ok(self.spawn_local_connection(purpose, connecting))
    }
}

impl LocalState {
    pub(crate) fn new(launch: LocalLaunch) -> Self {
        Self {
            launch,
            backend: None,
            bridge: None,
            slot: Arc::default(),
            submissions: events::Submissions::default(),
            features: Features::new(),
            prompted: false,
            busy: false,
        }
    }

    /// Builds the local agent off the input loop.
    pub(crate) fn connect(
        &self,
    ) -> impl std::future::Future<Output = Result<LocalConnection, String>> + Send + 'static {
        self.connect_with(Ok)
    }

    /// Like [`Self::connect`], but first derives the launch from the current one with
    /// `prepare` on the blocking pool (session lookups read the disk). The adopted
    /// backend's launch becomes the current one.
    pub(crate) fn connect_with(
        &self,
        prepare: impl FnOnce(LocalLaunch) -> Result<LocalLaunch, String> + Send + 'static,
    ) -> impl std::future::Future<Output = Result<LocalConnection, String>> + Send + 'static {
        let base = self.launch.clone();
        let slot = Arc::clone(&self.slot);
        let submissions = self.submissions.clone();
        async move {
            let launch = tokio::task::spawn_blocking(move || prepare(base))
                .await
                .map_err(|error| format!("session lookup failed: {error}"))??;
            let (backend, agent_events) = LocalBackend::build(launch)
                .await
                .map_err(|error| format!("{error:#}"))?;
            let (events, bridge) = events::spawn(agent_events, submissions);
            let connection = LocalConnection {
                agent: backend.handle.clone(),
                events,
                session_id: backend.handle.session_id().to_string(),
                workspace: backend.workspace.clone(),
                settings: local_settings(&backend),
                history: sessions::history_window(
                    &backend.transcript,
                    backend.handle.session_id(),
                ),
            };
            let replaced = slot
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .replace((backend, bridge));
            if let Some((old, bridge)) = replaced {
                bridge.abort();
                drop(old.shutdown().await);
            }
            Ok(connection)
        }
    }

    /// Adopts the backend built by [`Self::connect`] and attaches features.
    pub(crate) async fn adopt(&mut self) {
        let built = self
            .slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some((mut backend, bridge)) = built else {
            return;
        };
        if let Some(old) = self.backend.take() {
            self.features.shutdown();
            drop(old.shutdown().await);
        }
        if let Some(old) = self.bridge.replace(bridge) {
            old.abort();
        }
        self.launch = backend.launch.clone();
        self.busy = false;
        self.prompted = self.launch.resume.is_some();
        let capabilities = backend.capabilities();
        self.features.attach(
            &mut backend,
            ContextBase {
                capabilities,
                busy: self.busy,
                prompted: self.prompted,
                _marker: std::marker::PhantomData,
            },
        );
        // A branch edit submits its edited prompt once, on the new agent.
        if let Some(sessions::Resume::Branch { prompt, .. }) = backend.launch.resume.as_mut() {
            let text = std::mem::take(prompt);
            if !text.is_empty() {
                self.features
                    .host()
                    .send(super::features::FeatureUpdate::Submit { pane: None, text });
            }
        }
        if let Some(sessions::Resume::Branch { prompt, .. }) = self.launch.resume.as_mut() {
            prompt.clear();
        }
        self.backend = Some(backend);
    }

    pub(crate) fn capabilities(&self) -> Capabilities {
        self.backend
            .as_ref()
            .map_or(Capabilities::LOCAL, LocalBackend::capabilities)
    }

    /// Runs `f` with the features and a context over the current agent.
    pub(crate) fn with_features<R>(
        &mut self,
        f: impl FnOnce(&mut Features, &FeatureContext<'_>) -> R,
    ) -> R {
        let capabilities = self.capabilities();
        let host = self.features.host().clone();
        let fallback = self.launch.args.cwd().to_path_buf();
        let cx = FeatureContext {
            host: &host,
            capabilities,
            workspace: self
                .backend
                .as_ref()
                .map_or(fallback.as_path(), |backend| backend.workspace.as_path()),
            agent: self.backend.as_ref().map(|backend| &backend.handle),
            launch: Some(&self.launch),
            busy: self.busy,
            prompted: self.prompted,
        };
        f(&mut self.features, &cx)
    }

    /// Records the main agent's busy state and tells features when it changes.
    pub(crate) fn set_busy(&mut self, busy: bool) {
        if self.busy == busy {
            return;
        }
        self.busy = busy;
        self.with_features(|features, cx| features.turn_state(busy, cx));
    }

    /// Stops features, the bridge and every local runtime resource.
    pub(crate) async fn shutdown(&mut self) -> eyre::Result<()> {
        self.features.shutdown();
        if let Some(bridge) = self.bridge.take() {
            bridge.abort();
        }
        let pending = self.slot.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some((backend, bridge)) = pending {
            bridge.abort();
            backend.shutdown().await?;
        }
        match self.backend.take() {
            Some(backend) => backend.shutdown().await,
            None => Ok(()),
        }
    }
}

fn local_settings(backend: &LocalBackend) -> AgentSettings {
    let defaults = AgentSettings::default();
    let model = match backend.model {
        HarnessModel::Codex(model) => ManagedModel::Oai(model),
        // The picker shows the hosted default until WP1 maps Claude models.
        HarnessModel::Claude(_) => defaults.model,
    };
    AgentSettings {
        model,
        thinking: backend.launch.args.thinking(),
        fast_mode: backend.launch.args.fast_mode(),
        ..defaults
    }
}

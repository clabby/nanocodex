//! Branches of a local conversation: Ctrl+Alt+B (or /branches) opens the
//! navigator, editing an earlier prompt starts a new branch from the turns
//! before it, and switching reopens another branch in place. Ctrl+Alt+Up/Down
//! cycles branches without the navigator.
//!
//! Ported from the legacy TUI (`edit_historical`, `switch_main_branch`, branch
//! navigator). Branches are durable Codex threads: an edit copies the current
//! rollout through the completed turns before the edited prompt
//! (`rollout_fork`), so every branch can also be resumed later with `ncl resume`.

use std::sync::{Arc, Mutex, PoisonError};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nanocodex::agent::rollout::{RolloutConfig, RolloutTranscriptItem};

use super::{Feature, FeatureCommand, FeatureContext, FeatureUpdate, KeyOutcome, btw_local};
use crate::nanocodex2::tui::{
    components::BranchNavigator,
    local::{
        agent::{LocalLaunch, LocalParts},
        sessions,
    },
    pane::PaneId,
};

/// One branch of the current conversation family.
#[derive(Clone, Debug)]
pub(crate) struct Branch {
    pub(crate) thread: String,
    pub(crate) parent: Option<String>,
    pub(crate) label: String,
}

/// Branches known to this TUI session.
#[derive(Default)]
pub(crate) struct Registry {
    pub(crate) branches: Vec<Branch>,
    pub(crate) current: Option<String>,
    /// (parent, label) of a fresh branch whose thread id is known only after it connects.
    pub(crate) pending: Option<(Option<String>, String)>,
}

impl Registry {
    fn adopt(&mut self, thread: String) {
        if let Some((parent, label)) = self.pending.take() {
            if !self.branches.iter().any(|branch| branch.thread == thread) {
                self.branches.push(Branch {
                    thread: thread.clone(),
                    parent,
                    label,
                });
            }
        } else if !self.branches.iter().any(|branch| branch.thread == thread) {
            // A different conversation (/attach, /clear, startup) starts a new family.
            self.branches = vec![Branch {
                thread: thread.clone(),
                parent: None,
                label: "main".to_owned(),
            }];
        }
        self.current = Some(thread);
    }
}

pub(crate) type SharedRegistry = Arc<Mutex<Registry>>;

#[derive(Default)]
pub(crate) struct Branches {
    registry: SharedRegistry,
}

impl Feature for Branches {
    fn name(&self) -> &'static str {
        "branches"
    }

    fn attach(&mut self, _parts: &mut LocalParts, cx: &FeatureContext<'_>) {
        if let Some(agent) = cx.agent {
            let thread = agent
                .rollout()
                .map_or_else(|| agent.session_id().to_owned(), |rollout| rollout.thread_id().to_owned());
            self.registry
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .adopt(thread);
        }
    }

    fn command(&mut self, pane: PaneId, command: &FeatureCommand, cx: &FeatureContext<'_>) -> bool {
        if !matches!(command, FeatureCommand::Branches) {
            return false;
        }
        self.open(pane, cx);
        true
    }

    fn key(&mut self, key: &KeyEvent, cx: &FeatureContext<'_>) -> KeyOutcome {
        if !key.modifiers.contains(KeyModifiers::CONTROL | KeyModifiers::ALT) {
            return KeyOutcome::Ignored;
        }
        match key.code {
            KeyCode::Char('b' | 'B') => {
                self.open(PaneId::Main, cx);
                KeyOutcome::Consumed
            }
            KeyCode::Up => {
                self.cycle(-1, cx);
                KeyOutcome::Consumed
            }
            KeyCode::Down => {
                self.cycle(1, cx);
                KeyOutcome::Consumed
            }
            _ => KeyOutcome::Ignored,
        }
    }
}

impl Branches {
    fn open(&self, pane: PaneId, cx: &FeatureContext<'_>) {
        match navigator(&self.registry, cx) {
            Ok(navigator) => cx.host.send(FeatureUpdate::OpenOverlay(Box::new(navigator))),
            Err(error) => cx.host.error(Some(pane), error),
        }
    }

    fn cycle(&self, direction: isize, cx: &FeatureContext<'_>) {
        let target = {
            let registry = self.registry.lock().unwrap_or_else(PoisonError::into_inner);
            let count = registry.branches.len();
            if count < 2 {
                cx.host.error(None, "This conversation has no other branch; edit an earlier prompt with Ctrl+Alt+B");
                return;
            }
            let position = registry
                .current
                .as_ref()
                .and_then(|current| registry.branches.iter().position(|branch| &branch.thread == current))
                .unwrap_or(0);
            let next = position.cast_signed().saturating_add(direction).rem_euclid(count.cast_signed());
            registry.branches[next.cast_unsigned()].thread.clone()
        };
        if let Err(error) = ready(cx).and_then(|launch| switch(launch, &target)) {
            cx.host.error(None, error);
        }
    }
}

/// Branch switches and edits replace the main agent; legacy required the same.
fn ready<'a>(cx: &'a FeatureContext<'_>) -> Result<&'a LocalLaunch, String> {
    if cx.busy {
        return Err("finish or interrupt the main turn before switching branches".to_owned());
    }
    if btw_local::active().is_some() {
        return Err("close /btw before editing history or switching branches".to_owned());
    }
    cx.launch.ok_or_else(|| "branches need a local agent (run ncl)".to_owned())
}

/// Reopens `thread` in place.
pub(crate) fn switch(launch: &LocalLaunch, thread: &str) -> Result<(), String> {
    let launch = sessions::relaunch(launch, thread).map_err(|error| format!("{error:#}"))?;
    BRANCH_HOST.with_host(|host| host.send(FeatureUpdate::Relaunch(Box::new(launch))));
    Ok(())
}

fn navigator(registry: &SharedRegistry, cx: &FeatureContext<'_>) -> Result<BranchNavigator, String> {
    let launch = ready(cx)?.clone();
    let agent = cx.agent.ok_or("wait for the local agent to connect")?;
    BRANCH_HOST.set(cx.host.clone());
    // Edits fork the Codex rollout; Claude sessions use ncl rewind instead.
    let rollout = agent.rollout().map(|rollout| (rollout.thread_id().to_owned(), rollout.path().to_path_buf()));
    let prompts = match &rollout {
        Some((thread, _)) => {
            let home = crate::config::default_codex_home().map_err(|error| error.to_string())?;
            RolloutConfig::new(&home)
                .load_session(thread)
                .map(|session| {
                    session
                        .transcript()
                        .iter()
                        .filter_map(|item| match item {
                            RolloutTranscriptItem::User(text) => Some(text.clone()),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        None => Vec::new(),
    };
    Ok(BranchNavigator::new(
        Arc::clone(registry),
        cx.host.clone(),
        launch,
        cx.workspace.to_path_buf(),
        rollout.map(|(_, path)| path),
        prompts,
    ))
}

/// Starts a branch whose history ends before prompt `index` (0-based) and
/// submits `prompt` there.
pub(crate) fn edit(
    registry: &SharedRegistry,
    launch: &LocalLaunch,
    workspace: &std::path::Path,
    rollout: Option<&std::path::Path>,
    index: usize,
    prompt: String,
) -> Result<LocalLaunch, String> {
    let label = branch_label(&prompt, index);
    let mut registry = registry.lock().unwrap_or_else(PoisonError::into_inner);
    let parent = registry.current.clone();
    if index == 0 {
        // Nothing precedes the first prompt: the branch is a fresh session.
        let mut fresh = sessions::fresh(launch);
        fresh.replaceable = false;
        fresh.resume = Some(sessions::Resume::Branch { thread: None, prompt });
        registry.pending = Some((parent, label));
        return Ok(fresh);
    }
    let rollout = rollout.ok_or("editing history needs a saved Codex rollout; this session has none (Claude sessions use ncl rewind)")?;
    let home = crate::config::default_codex_home().map_err(|error| error.to_string())?;
    let thread = crate::rollout_fork::fork(
        rollout,
        &crate::rollout_fork::Point::Count(index),
        &home,
        workspace,
    )
    .map_err(|error| format!("could not start a branch: {error:#}"))?;
    let mut branch = sessions::relaunch(launch, &thread).map_err(|error| format!("{error:#}"))?;
    branch.resume = Some(sessions::Resume::Branch {
        thread: Some(thread.clone()),
        prompt,
    });
    registry.branches.push(Branch {
        thread,
        parent,
        label,
    });
    Ok(branch)
}

fn branch_label(prompt: &str, index: usize) -> String {
    let first = prompt.lines().next().unwrap_or_default().trim();
    let mut label = first.chars().take(40).collect::<String>();
    if first.chars().count() > 40 {
        label.push_str("...");
    }
    format!("{label} (edit of prompt {})", index + 1)
}

/// The host of the session that opened the navigator, for branch switches.
struct HostCell(Mutex<Option<super::FeatureHost>>);

impl HostCell {
    fn set(&self, host: super::FeatureHost) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(host);
    }

    fn with_host(&self, send: impl FnOnce(&super::FeatureHost)) {
        if let Some(host) = self.0.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            send(host);
        }
    }
}

static BRANCH_HOST: HostCell = HostCell(Mutex::new(None));

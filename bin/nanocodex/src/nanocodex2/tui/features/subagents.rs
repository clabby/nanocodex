//! Local subagent tree and completion continuation.
//!
//! Port of the legacy receive_subagent_update/handle_subagent_update arm: every
//! ScopedAgentUpdate from the local child-agent registry feeds the shared
//! subagent tree (AppEvent::Subagent). When a direct child of the current root
//! session completes after the main turn ended, the main agent is prompted once
//! to integrate its result ("[Subagent N completed]"), fired from idle_tick so
//! user input and queued turns keep priority.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, PoisonError},
};

use nanocodex_subagents::{AgentId, AgentStatus, AgentUpdate, ScopedAgentUpdate};
use tokio::{sync::mpsc, task::JoinHandle};

use super::{Feature, FeatureContext, FeatureHost, FeaturePrompt, FeatureUpdate};
use crate::nanocodex2::tui::{local::agent::LocalParts, pane::PaneId};

type Completions = Arc<Mutex<VecDeque<(String, AgentId)>>>;

#[derive(Default)]
pub(crate) struct Subagents {
    task: Option<JoinHandle<()>>,
    completions: Completions,
}

impl Feature for Subagents {
    fn name(&self) -> &'static str {
        "subagents"
    }

    fn attach(&mut self, parts: &mut LocalParts, cx: &FeatureContext<'_>) {
        self.shutdown();
        self.completions = Completions::default();
        if let Some(updates) = parts.subagent_updates.take() {
            self.task = Some(tokio::spawn(forward(
                updates,
                cx.host.clone(),
                Arc::clone(&self.completions),
            )));
        }
    }

    fn idle_tick(&mut self, cx: &FeatureContext<'_>) {
        let Some(agent) = cx.agent else {
            return;
        };
        let next = {
            let mut completions = self.completions.lock().unwrap_or_else(PoisonError::into_inner);
            let session = agent.session_id();
            completions.retain(|(root, _)| root == session);
            completions.pop_front()
        };
        let Some((_, id)) = next else {
            return;
        };
        cx.host.send(FeatureUpdate::SubmitPrompt(FeaturePrompt {
            pane: Some(PaneId::Main),
            display: format!("[Subagent {id} completed]"),
            instruction: Some(format!(
                "A direct subagent completed after the previous turn ended. Continue the current task by \
                 inspecting its structured result. Call list_agents with include_completed=true, find agent \
                 {id}, integrate and verify the relevant findings, finish any remaining work, and then \
                 respond to the user. Do not merely repeat the raw subagent result.\n\n\
                 <subagent_completion agent_id=\"{id}\" />"
            )),
            completion: None,
        }));
    }

    fn shutdown(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn forward(
    mut updates: mpsc::UnboundedReceiver<ScopedAgentUpdate>,
    host: FeatureHost,
    completions: Completions,
) {
    let mut direct_children: HashMap<String, HashSet<AgentId>> = HashMap::new();
    let mut completed: HashMap<String, HashSet<AgentId>> = HashMap::new();
    while let Some(scoped) = updates.recv().await {
        let root = scoped.root_session_id.clone();
        match &scoped.update {
            AgentUpdate::Added(agent) => {
                let children = direct_children.entry(root.clone()).or_default();
                if agent.parent.is_none() {
                    children.insert(agent.id);
                } else {
                    children.remove(&agent.id);
                }
            }
            AgentUpdate::Status { id, status } => {
                let done = completed.entry(root.clone()).or_default();
                if matches!(status, AgentStatus::Completed { .. }) {
                    if done.insert(*id)
                        && direct_children.get(&root).is_some_and(|children| children.contains(id))
                    {
                        completions
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push_back((root.clone(), *id));
                    }
                } else {
                    done.remove(id);
                }
            }
            AgentUpdate::Event { .. } | AgentUpdate::Message(_) => {}
        }
        host.send(FeatureUpdate::Subagent(scoped.update));
    }
}

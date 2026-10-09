//! The local, non-durable agent behind `ncl` / `nanocodex --local`.
//!
//! [`LocalBackend`] owns every runtime piece a `ConfiguredAgent` carries. Feature
//! modules take the optional pieces they drive (Claude interactions, the Claude
//! scheduler, MCP, Realtime voice, subagent updates) through [`LocalParts`] when
//! [`super::super::features::Features::attach`] runs; the driver keeps the handle,
//! the event bridge and the lifecycle resources, and shuts them down on exit.

use std::{path::PathBuf, sync::Arc};

use eyre::{Result, WrapErr as _};
use nanocodex::{HarnessModel, Nanocodex, OpenAi, tools::mcp::McpHandle};

use crate::config::{
    AgentArgs, ConfiguredAgent, InteractionReceiver, SessionScheduler,
};
use crate::nanocodex2::tui::backend::Capabilities;
use crate::subagents::ChildAgents;
use crate::vm::VmArgs;

/// The optional runtime pieces feature modules may take ownership of.
#[derive(Default)]
pub(crate) struct LocalParts {
    pub(crate) claude_scheduler: Option<Arc<SessionScheduler>>,
    pub(crate) claude_interactions: Option<InteractionReceiver>,
    pub(crate) realtime: Option<OpenAi>,
    pub(crate) mcp: Option<McpHandle>,
    pub(crate) child_agents: Option<Arc<ChildAgents>>,
    pub(crate) subagent_updates:
        Option<tokio::sync::mpsc::UnboundedReceiver<nanocodex_subagents::ScopedAgentUpdate>>,
}

/// How `ncl` was launched. Feature modules that rebuild the agent (harness
/// switch, /clear, local /btw, resume) start from these arguments.
#[derive(Clone)]
pub(crate) struct LocalLaunch {
    pub(crate) args: AgentArgs,
    pub(crate) vm: VmArgs,
    /// Whether the backend may still be rebuilt with a different harness.
    pub(crate) replaceable: bool,
}

/// A running local agent and the resources it must release on exit.
pub(crate) struct LocalBackend {
    pub(crate) launch: LocalLaunch,
    pub(crate) handle: Nanocodex,
    pub(crate) model: HarnessModel,
    pub(crate) workspace: PathBuf,
    pub(crate) parts: LocalParts,
    mpp_adapter: Option<crate::mpp::MppAdapter>,
    browser: Option<crate::browser::ConfiguredBrowser>,
    vm: Option<crate::vm::ConfiguredVm>,
    child_agents: Option<Arc<ChildAgents>>,
}

impl LocalBackend {
    /// Splits a built agent into the backend and its event stream.
    pub(crate) fn new(
        launch: LocalLaunch,
        workspace: PathBuf,
        agent: ConfiguredAgent,
    ) -> (Self, nanocodex::AgentEvents) {
        let ConfiguredAgent {
            claude_scheduler,
            claude_interactions,
            handle,
            events,
            realtime,
            child_agents,
            subagent_updates,
            mpp_adapter,
            mcp,
            browser,
            vm,
            model,
        } = agent;
        let backend = Self {
            launch,
            handle,
            model,
            workspace,
            parts: LocalParts {
                claude_scheduler,
                claude_interactions,
                realtime,
                mcp,
                child_agents: child_agents.clone(),
                subagent_updates,
            },
            mpp_adapter,
            browser,
            vm,
            child_agents,
        };
        (backend, events)
    }

    /// Builds a fresh local agent off the input loop.
    pub(crate) async fn build(launch: LocalLaunch) -> Result<(Self, nanocodex::AgentEvents)> {
        let workspace = launch.args.cwd().to_path_buf();
        let agent = launch
            .args
            .clone()
            .build_tui(launch.vm.clone())
            .await
            .wrap_err("could not start the local agent")?;
        Ok(Self::new(launch, workspace, agent))
    }

    /// Feature visibility for this agent.
    pub(crate) fn capabilities(&self) -> Capabilities {
        let mut capabilities = Capabilities::LOCAL;
        capabilities.voice_realtime = self.parts.realtime.is_some();
        capabilities.claude_host = matches!(
            self.model.family(),
            nanocodex::HarnessFamily::Claude
        );
        capabilities
    }

    /// Releases subagents, browser, VM and MPP resources (legacy shutdown_runtime).
    pub(crate) async fn shutdown(self) -> Result<()> {
        if let Some(child_agents) = self.child_agents {
            child_agents.shutdown().await;
        }
        drop(self.handle);
        let browser = match self.browser {
            Some(browser) => browser.shutdown().await,
            None => Ok(()),
        };
        let vm = match self.vm {
            Some(vm) => vm.shutdown().await,
            None => Ok(()),
        };
        let mpp = match self.mpp_adapter {
            Some(adapter) => adapter.shutdown().await,
            None => Ok(()),
        };
        browser?;
        vm?;
        mpp
    }
}

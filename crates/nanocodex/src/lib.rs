#![doc = include_str!("../README.md")]
#![deny(missing_docs, rustdoc::broken_intra_doc_links)]
#![cfg_attr(docsrs, feature(doc_cfg))]

#[cfg(feature = "openai")]
#[cfg_attr(docsrs, doc(cfg(feature = "openai")))]
pub use nanocodex_agent::NanocodexBuilder;
pub use nanocodex_agent::{
    AgentEvents, AgentSessionContext, CostStatus, EstimatedUsdCost, ExecutionPolicyDisposition,
    Nanocodex, NanocodexError, PromptRequest, PromptRoute, ReportedTurnUsage, ServiceTier, Turn,
    TurnControl, TurnResult, TurnUsage, UsdAmount,
};
#[cfg(feature = "claude")]
#[cfg_attr(docsrs, doc(cfg(feature = "claude")))]
pub use nanocodex_claude::Claude;
#[cfg(feature = "durability")]
#[cfg_attr(docsrs, doc(cfg(feature = "durability")))]
pub use nanocodex_durability::DurableAgentExt;
#[cfg(all(not(target_family = "wasm"), feature = "managed"))]
#[cfg_attr(
    docsrs,
    doc(cfg(all(not(target_family = "wasm"), feature = "managed")))
)]
pub use nanocodex_managed::{Managed, ManagedApiKey};
#[cfg(feature = "openai")]
#[cfg_attr(docsrs, doc(cfg(feature = "openai")))]
pub use nanocodex_oai_api::OpenAi;
pub use nanocodex_oai_api::{Model, ReasoningMode, Thinking};
#[cfg(feature = "tools")]
#[cfg_attr(docsrs, doc(cfg(feature = "tools")))]
pub use nanocodex_tools::Tool;
#[cfg(all(
    feature = "tools",
    any(feature = "openai", not(target_family = "wasm"))
))]
#[cfg_attr(
    docsrs,
    doc(cfg(all(
        feature = "tools",
        any(feature = "openai", not(target_family = "wasm"))
    )))
)]
pub use nanocodex_tools::Tools;
#[cfg(all(feature = "openai", feature = "tools", not(target_family = "wasm")))]
#[cfg_attr(
    docsrs,
    doc(cfg(all(feature = "openai", feature = "tools", not(target_family = "wasm"))))
)]
pub use nanocodex_tools::tool;

/// Owned agent lifecycle, builders, turns, branching, and snapshots.
///
/// Provider and tool-runtime APIs keep their canonical detailed paths under
/// [`crate::oai`] and [`crate::tools`].
pub mod agent {
    #[cfg(feature = "durability")]
    #[cfg_attr(docsrs, doc(cfg(feature = "durability")))]
    pub use crate::durability;
    #[cfg(all(feature = "openai", not(target_family = "wasm")))]
    #[cfg_attr(docsrs, doc(cfg(all(feature = "openai", not(target_family = "wasm")))))]
    pub use nanocodex_agent::rollout;
    pub use nanocodex_agent::{
        AgentEvents, AgentSessionContext, BuilderBackend, CostStatus, EstimatedUsdCost,
        ExecutionPolicyDisposition, Nanocodex, NanocodexError, PromptRequest, PromptRoute,
        ReportedTurnUsage, Result, ServiceTier, SpawnOptions, Turn, TurnControl, TurnResult,
        TurnUsage, UsdAmount, events, input, session, usage,
    };
    #[cfg(feature = "openai")]
    #[cfg_attr(docsrs, doc(cfg(feature = "openai")))]
    pub use nanocodex_agent::{AgentHandle, ExecutionEnvironment, NanocodexBuilder, execution};
}

/// Anthropic Messages client, provider-native builder, protocol, and authentication.
#[cfg(feature = "claude")]
#[cfg_attr(docsrs, doc(cfg(feature = "claude")))]
#[doc(inline)]
pub use nanocodex_claude as claude;

/// Portable durable execution policy and host-store contracts.
#[cfg(feature = "durability")]
#[cfg_attr(docsrs, doc(cfg(feature = "durability")))]
#[doc(inline)]
pub use nanocodex_durability as durability;

/// Tower-native OpenAI Responses client, sessions, protocol, and transport.
#[doc(inline)]
pub use nanocodex_oai_api as oai;

/// Tool registry, built-ins, MCP, tool search, and Code Mode.
#[cfg(feature = "tools")]
#[cfg_attr(docsrs, doc(cfg(feature = "tools")))]
#[doc(inline)]
pub use nanocodex_tools as tools;

/// Native account-managed backend, administration client, and durable event transport.
#[cfg(all(not(target_family = "wasm"), feature = "managed"))]
#[cfg_attr(
    docsrs,
    doc(cfg(all(not(target_family = "wasm"), feature = "managed")))
)]
#[doc(inline)]
pub use nanocodex_managed as managed;

/// Application-owned tracing and OpenTelemetry setup.
#[cfg(all(not(target_family = "wasm"), feature = "observability"))]
#[cfg_attr(
    docsrs,
    doc(cfg(all(not(target_family = "wasm"), feature = "observability")))
)]
#[doc(inline)]
pub use nanocodex_observability as observability;

/// Common imports for the golden owned-agent path.
pub mod prelude {
    #[cfg(feature = "claude")]
    #[cfg_attr(docsrs, doc(cfg(feature = "claude")))]
    pub use crate::Claude;
    #[cfg(feature = "durability")]
    #[cfg_attr(docsrs, doc(cfg(feature = "durability")))]
    pub use crate::DurableAgentExt;
    #[cfg(feature = "tools")]
    #[cfg_attr(docsrs, doc(cfg(feature = "tools")))]
    pub use crate::Tool;
    #[cfg(all(
        feature = "tools",
        any(feature = "openai", not(target_family = "wasm"))
    ))]
    #[cfg_attr(
        docsrs,
        doc(cfg(all(
            feature = "tools",
            any(feature = "openai", not(target_family = "wasm"))
        )))
    )]
    pub use crate::Tools;
    #[cfg(all(feature = "openai", feature = "tools", not(target_family = "wasm")))]
    #[cfg_attr(
        docsrs,
        doc(cfg(all(feature = "openai", feature = "tools", not(target_family = "wasm"))))
    )]
    pub use crate::tool;
    pub use crate::{Model, Nanocodex};
    #[cfg(feature = "openai")]
    #[cfg_attr(docsrs, doc(cfg(feature = "openai")))]
    pub use crate::{NanocodexBuilder, OpenAi};
}

#[cfg(all(feature = "openai", feature = "tools", not(target_family = "wasm")))]
#[doc(hidden)]
pub mod __private {
    pub use nanocodex_tools::__private::*;
}

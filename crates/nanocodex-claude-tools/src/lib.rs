//! Independent Claude-native capability adapters. No model transport, ambient
//! permissions, host lifecycle, OAuth, or provider implementation is installed.
//! Embeddings explicitly supply and authorize every external capability.

pub mod bash;
pub mod host;
#[cfg(not(target_family = "wasm"))]
pub mod notebook;
pub mod tasks;
pub mod web;
#[cfg(not(target_family = "wasm"))]
pub mod workspace_files;

pub use bash::{BashRequest, BashResult, ClaudeBash, SandboxBashExecutor};
pub use host::{
    ClaudeHost, ClaudeHostTools, ClaudeMcp, ClaudeMcpProvider, HostContext, HostRequest, HostTool,
    ImageSource, McpToolDefinition, ToolContent, ToolOutput, ToolResultBlock,
};
#[cfg(not(target_family = "wasm"))]
pub use notebook::ClaudeNotebook;
pub use tasks::ClaudeTasks;
pub use web::{
    ApprovedPage, ApprovedWebFetchSource, ApprovedWebProvider, ClaudeWeb, WebFetchRequest,
    WebSearchRequest,
};
#[cfg(not(target_family = "wasm"))]
pub use workspace_files::ClaudeWorkspaceFiles;

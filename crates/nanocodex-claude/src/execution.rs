//! Optional execution-policy seam for Claude-native checkpoints and effects.
//!
//! The `nanocodex-durability` crate supplies the store-backed implementation.
//! Payloads retain provider-native blocks without translating signed content.
use nanocodex_agent::Result;
use serde_json::Value;
use std::{future::Future, pin::Pin};

/// Future returned by a host execution policy.
#[cfg(not(target_family = "wasm"))]
pub type PolicyFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
/// Future returned by an isolate-local execution policy.
#[cfg(target_family = "wasm")]
pub type PolicyFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + 'a>>;

/// Admission result from the authoritative store.
pub enum Admission {
    /// New operation.
    Execute,
    /// Previously accepted unfinished operation.
    Resume,
    /// Exact terminal receipt; does not rewind the current session.
    Completed { checkpoint: Value, output: Value },
    /// Previously failed operation.
    Failed { checkpoint: Value, error: String },
    /// Previously cancelled operation.
    Cancelled,
}
/// Admission of one external effect.
pub enum Step {
    /// Perform the effect. Unsettled effects may execute again after a crash.
    Execute,
    /// Exact settled output, without invoking the handler.
    Replay(Value),
}
/// Host-owned durable execution, sharing Nanocodex's store and fencing rules.
pub trait ClaudeExecutionPolicy: Send + Sync {
    fn state_id(&self) -> &str;
    fn admit(
        &self,
        id: String,
        input: Value,
        automatic: bool,
    ) -> PolicyFuture<'_, (String, Admission)>;
    fn begin_attempt(&self, id: String) -> PolicyFuture<'_, ()>;
    fn continuation(&self, id: String) -> PolicyFuture<'_, Option<Value>>;
    fn advance(&self, id: String, state: Value) -> PolicyFuture<'_, ()>;
    fn begin_step(
        &self,
        id: String,
        step_id: String,
        kind: String,
        input: Value,
    ) -> PolicyFuture<'_, Step>;
    fn complete_step(&self, id: String, step_id: String, output: Value) -> PolicyFuture<'_, ()>;
    fn complete(&self, id: String, checkpoint: Value, output: Value) -> PolicyFuture<'_, ()>;
    fn fail(&self, id: String, checkpoint: Value, error: String) -> PolicyFuture<'_, ()>;
    fn cancel(&self, id: String, checkpoint: Value) -> PolicyFuture<'_, ()>;
    fn release(&self, id: String) -> PolicyFuture<'_, ()>;
    fn shutdown(&self) -> PolicyFuture<'_, ()>;
    fn checkpoint(&self, state: Value) -> PolicyFuture<'_, ()>;
}

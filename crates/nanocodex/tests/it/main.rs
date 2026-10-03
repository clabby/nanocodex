#![allow(missing_docs)]

#[cfg(all(feature = "openai", feature = "tools", not(target_family = "wasm")))]
mod tool_macro;

#[cfg(all(
    feature = "claude",
    feature = "durability",
    not(target_family = "wasm")
))]
mod claude;

#[cfg(all(
    feature = "claude",
    feature = "openai",
    feature = "tools",
    not(target_family = "wasm")
))]
mod harness;

const fn main() {}

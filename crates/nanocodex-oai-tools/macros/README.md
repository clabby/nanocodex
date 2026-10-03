# Nanocodex OpenAI Tools Macros

Procedural macro implementation for `nanocodex-oai-tools`.

Applications should not add this package directly. Add `nanocodex-oai-tools` or
the `nanocodex` facade and import the re-exported `tool` macro:

```rust,ignore
use nanocodex_oai_tools::{Tools, tool};

#[tool(
    name = "deployment_region",
    description = "Return the production region for a named service.",
    parallel = true
)]
async fn deployment_region(service: String) -> Result<String, std::io::Error> {
    Ok(format!("{service}: us-west-2"))
}

let tools = Tools::builder()
    .without_defaults()
    .tool(deployment_region)
    .build()?;
```

The macro requires an `async fn` returning `Result<T, E>`. Function arguments
become a strict JSON input schema and `T` becomes the output schema. `name`
defaults to the Rust function name. Tools execute serially unless
`parallel = true` explicitly permits overlapping local execution.

This separate package exists only to satisfy Rust's procedural-macro crate
boundary. The supported user-facing paths are `nanocodex_oai_tools::tool` and
`nanocodex::tool`.

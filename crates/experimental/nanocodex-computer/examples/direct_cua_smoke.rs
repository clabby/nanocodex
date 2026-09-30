//! Opt-in live smoke. Set NANOCODEX_DIR to a separate staged, signed, no-Codex
//! runtime. This never selects or restarts the user's existing Hand.
use nanocodex_computer::{ComputerTools, provision};
use nanocodex_oai_api::tools::{Tool, ToolContext, ToolInput};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::var_os("NANOCODEX_DIR").is_none() {
        return Err("Set NANOCODEX_DIR to an isolated staged runtime first".into());
    }
    let receipt = provision::provision_upstream(false).await?;
    let config = provision::config_from_receipt(&receipt)?;
    println!(
        "{}",
        json!({"build":receipt["build"],"transport":receipt["transport"],"launcher":config.executable})
    );
    let computer = ComputerTools::connect(config).await?;
    println!(
        "{}",
        json!({"catalog":computer.catalog().iter().map(|t|t.name.as_str()).collect::<Vec<_>>()})
    );
    for (call, code) in [
        (
            "arithmetic",
            "let smokeValue = 41; nodeRepl.write(smokeValue+1)",
        ),
        ("persistent", "nodeRepl.write(smokeValue+1)"),
        (
            "native_observation",
            "const smokeFinder = await cua.getApp('com.apple.finder');",
        ),
    ] {
        let input = ToolInput::Function(serde_json::value::to_raw_value(
            &json!({"code":code,"timeout_ms":20000}),
        )?);
        let output = computer
            .js()
            .execute(
                input,
                ToolContext::new("direct-cua-smoke", "live-rust-smoke", call, &[], 16000)
                    .with_turn_id(Some("live-smoke")),
            )
            .await?;
        let result = output.structured_result();
        let content: Vec<Value> = result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                if c["type"] == "text" {
                    let text = c["text"].as_str().unwrap_or_default();
                    if text.len() < 50 || !output.success {
                        json!({"type":"text","text":text})
                    } else {
                        json!({"type":"text","bytes":text.len()})
                    }
                } else {
                    json!({"type":c["type"]})
                }
            })
            .collect();
        println!(
            "{}",
            json!({"call":call,"success":output.success,"content":content})
        );
        if !output.success {
            return Err(format!("Live CUA {call} failed").into());
        }
    }
    let reset = computer
        .reset()
        .execute(
            ToolInput::Function(serde_json::value::to_raw_value(&json!({}))?),
            ToolContext::new("direct-cua-smoke", "live-rust-smoke", "reset", &[], 16000)
                .with_turn_id(Some("live-smoke")),
        )
        .await?;
    println!("{}", json!({"resetSuccess":reset.success}));
    if !reset.success {
        return Err("Live reset failed".into());
    }
    drop(computer);
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    Ok(())
}

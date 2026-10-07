//! Installation management shared by both native CLIs.
use clap::{Args, Subcommand};
use std::{fs, path::PathBuf, process::Stdio};

#[derive(Args)]
pub(crate) struct Computer {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Install and select OpenAI's signed headless CUA components.
    Setup {
        /// Check OpenAI's component feed and update when its signed build changed.
        #[arg(long)]
        refresh: bool,
        /// Internal background preparation; coalesce concurrent startup requests.
        #[arg(long, hide = true)]
        background: bool,
    },
}

impl Computer {
    pub(crate) async fn run(self) -> Result<(), String> {
        let Command::Setup {
            refresh,
            background,
        } = self.command;
        let _background_lock = if background {
            let directory = setup_directory()?;
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let mut options = fs::OpenOptions::new();
            options.create(true).read(true).write(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
            }
            let lock = options
                .open(directory.join("background.lock"))
                .map_err(|error| error.to_string())?;
            match lock.try_lock() {
                Ok(()) => Some(lock),
                Err(std::fs::TryLockError::WouldBlock) => return Ok(()),
                Err(error) => return Err(error.to_string()),
            }
        } else {
            None
        };
        if background {
            eprintln!("Preparing signed Computer Use components…");
        }
        let receipt = nanocodex_computer::provision::provision_upstream(refresh).await?;
        // Discover the exact provider catalog off the interactive path, so a
        // later attachment can register it from the version-bound cache.
        if receipt["status"] == "installed" {
            eprintln!("Components verified; preparing the Computer Use tool catalog…");
            let config = nanocodex_computer::provision::config_from_receipt(&receipt)?;
            nanocodex_computer::ComputerTools::connect(config)
                .await
                .map_err(|error| error.to_string())?;
            eprintln!(
                "Computer Use components are ready; running Hands discover them on their next computer call."
            );
        }
        println!("{receipt}");
        Ok(())
    }
}

/// Connect the Hand before optional CUA downloads. The child owns provisioning
/// (including its cross-process lock) and survives installer exit. Explicit
/// provider selections, including `off`, never trigger a download.
#[allow(dead_code)] // Also compiled into the managed CLI.
pub(crate) fn setup_in_background(refresh: bool) -> Result<Option<PathBuf>, String> {
    if !cfg!(target_os = "macos")
        || std::env::var_os("NANOCODEX_COMPUTER").is_some_and(|value| !value.is_empty())
    {
        return Ok(None);
    }
    let directory = setup_directory()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let log_path = directory.join("setup.log");
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    let log = options.open(&log_path).map_err(|error| error.to_string())?;
    if !log.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Computer Use setup log must be a regular file".into());
    }
    let mut command =
        std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.args(["computer", "setup", "--background"]);
    if refresh {
        command.arg("--refresh");
    }
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    // Reap while the caller stays open. Exiting the caller does not terminate
    // the independently owned installer.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(Some(log_path))
}

fn setup_directory() -> Result<PathBuf, String> {
    let base = std::env::var_os("NANOCODEX_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".nanocodex")))
        .ok_or("HOME or NANOCODEX_DIR is required for Computer Use setup")?;
    Ok(base.join("runtimes/openai-cua"))
}

/// Optional managed CUA may not hold shell, file access, or first input behind
/// MCP startup. Explicit custom providers retain their normal error contract.
pub(crate) async fn connect_for_startup()
-> Result<Option<nanocodex_computer::ComputerTools>, String> {
    if let Err(error) = setup_in_background(false) {
        tracing::warn!(%error, "could not start background Computer Use setup");
    }
    let Some(config) = nanocodex_computer::ComputerConfig::discover() else {
        return Ok(None);
    };
    if std::env::var_os("NANOCODEX_COMPUTER").is_some_and(|value| !value.is_empty()) {
        return nanocodex_computer::ComputerTools::connect(config)
            .await
            .map(Some)
            .map_err(|error| error.to_string());
    }
    match tokio::time::timeout(
        std::time::Duration::from_millis(500),
        nanocodex_computer::ComputerTools::connect(config),
    )
    .await
    {
        Ok(Ok(computer)) => Ok(Some(computer)),
        Ok(Err(error)) => {
            tracing::warn!(%error, "optional Computer Use provider unavailable; continuing startup");
            Ok(None)
        }
        Err(_) => {
            tracing::info!(
                "Computer Use is still preparing; continuing startup with native Hand controls"
            );
            Ok(None)
        }
    }
}

/// Stable Hand catalog: provisioning may finish after the publisher connects.
/// Resolve the provider on use, retaining it once connected so existing realms
/// and workspace processes survive. No action is retried after dispatch.
#[allow(dead_code)] // Shared with the CLI installer, which does not publish tools.
pub(crate) async fn connect_for_hand() -> Result<Option<nanocodex_computer::ComputerTools>, String>
{
    if std::env::var_os("NANOCODEX_COMPUTER").is_some_and(|value| !value.is_empty()) {
        return connect_for_startup().await;
    }
    // Linux keeps its working native screen when no managed provider is selected.
    // macOS provisions signed components asynchronously after Hand startup.
    if !cfg!(target_os = "macos") && nanocodex_computer::ComputerConfig::discover().is_none() {
        return Ok(None);
    }
    if let Err(error) = setup_in_background(false) {
        tracing::warn!(%error, "could not start background Computer Use setup");
    }
    use serde_json::json;
    let catalog = ["js", "js_reset"].into_iter().map(|name| {
        serde_json::from_value(json!({
            "name": name,
            "description": "NANOCODEX_DYNAMIC_CUA_V1. Persistent Computer Use gateway. Call with no arguments first to discover the live provider's exact tools, schemas and instructions. Then pass its js/js_reset arguments directly, or use provider_tool and arguments for another model-visible provider tool. Components may still be preparing; a later call discovers their completed installation without restarting the Hand. Catalog availability does not prove screen capture or input permission.",
            "inputSchema": {"type":"object", "additionalProperties":true}
        })).expect("static gateway catalog")
    }).collect();
    Ok(Some(nanocodex_computer::ComputerTools::new(
        LazyComputer {
            connected: tokio::sync::Mutex::new(None),
        },
        catalog,
    )))
}

#[allow(dead_code)]
struct LazyComputer {
    connected: tokio::sync::Mutex<Option<nanocodex_computer::ComputerTools>>,
}

#[async_trait::async_trait]
impl nanocodex_computer::ComputerExecutor for LazyComputer {
    async fn end_turn(
        &self,
        session: &str,
        turn: &str,
        event: &str,
    ) -> Result<(), nanocodex::oai::tools::ToolError> {
        let computer = self.connected.lock().await.clone();
        if let Some(computer) = computer {
            computer.end_turn(session, turn, event).await?;
        }
        Ok(())
    }

    async fn invoke_tool(
        &self,
        name: &str,
        arguments: serde_json::Value,
        context: nanocodex::oai::tools::ToolContext<'_>,
    ) -> nanocodex::oai::tools::ToolResult {
        use nanocodex::oai::tools::{Tool as _, ToolInput};
        use serde_json::json;
        let discovery =
            name == "js" && arguments.as_object().is_some_and(serde_json::Map::is_empty);
        let computer = {
            let mut connected = self.connected.lock().await;
            if connected.is_none() {
                let Some(config) = nanocodex_computer::ComputerConfig::discover() else {
                    if discovery {
                        return discovery_output(json!({"status":"preparing"}));
                    }
                    return Err("Computer Use components are unavailable; discover the Hand contract again before sending input".into());
                };
                // Discovery is read-only. Bound optional initialization so native
                // screen controls remain reachable while components prepare.
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    nanocodex_computer::ComputerTools::connect(config),
                )
                .await
                {
                    Ok(Ok(computer)) => *connected = Some(computer),
                    result if discovery => {
                        let _ = result;
                        tracing::debug!("Computer provider is not ready during discovery");
                        return discovery_output(json!({"status":"preparing"}));
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(_) => {
                        return Err(
                            "Computer Use initialization timed out; no action was dispatched"
                                .into(),
                        );
                    }
                }
            }
            connected.as_ref().expect("connected above").clone()
        };
        if discovery {
            let catalog = computer
                .tools()
                .map(|tool| {
                    let mut definition = serde_json::to_value(tool.definition())
                        .expect("serializable provider tool definition");
                    definition["name"] = json!(tool.provider_definition().name);
                    definition
                })
                .collect::<Vec<_>>();
            return discovery_output(json!({"status":"ready", "definitions":catalog}));
        }
        let (name, arguments) = match arguments.get("provider_tool") {
            Some(tool) => (
                tool.as_str().ok_or("provider_tool must be a string")?,
                arguments
                    .get("arguments")
                    .cloned()
                    .ok_or("arguments is required with provider_tool")?,
            ),
            None => (name, arguments.clone()),
        };
        let tool = computer.tool(name).filter(|tool| tool.provider_definition().model_visible())
            .ok_or("The selected provider does not expose this model-visible tool; discover its catalog first")?;
        tool.execute(
            ToolInput::Function(serde_json::value::to_raw_value(&arguments)?),
            context,
        )
        .await
    }
}

#[allow(dead_code)]
fn discovery_output(value: serde_json::Value) -> nanocodex::oai::tools::ToolResult {
    nanocodex_computer::output(
        serde_json::json!({"content":[{"type":"text", "text":value.to_string()}]}),
    )
}

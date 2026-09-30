//! Build an explicitly selected upstream revision before installing either binary.

use std::{path::Path, process::Output};

use eyre::{Context, Result, bail, eyre};
use serde::Deserialize;
use tokio::process::Command;

use super::{REPOSITORY, local};

const SOURCE_URL: &str = "https://github.com/gakonst/nanocodex.git";

#[derive(Clone, Copy)]
pub(super) enum Selection<'a> {
    Branch(&'a str),
    Pr(u64),
}

impl Selection<'_> {
    pub(super) fn key_prefix(self) -> String {
        match self {
            Self::Branch(_) => "branch".into(),
            Self::Pr(number) => format!("pr-{number}"),
        }
    }

    pub(super) fn description(self) -> String {
        match self {
            Self::Branch(name) => format!("branch {name}"),
            Self::Pr(number) => format!("PR #{number}"),
        }
    }

    fn reference(self) -> String {
        match self {
            Self::Branch(name) => format!("refs/heads/{name}"),
            Self::Pr(number) => format!("refs/pull/{number}/head"),
        }
    }
}

pub(super) struct Build {
    pub(super) sha: String,
    pub(super) cli: Vec<u8>,
    pub(super) hand: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    head_ref_oid: String,
    state: String,
}

pub(super) async fn build(selection: Selection<'_>, target: &Path) -> Result<Build> {
    let expected_sha = match selection {
        Selection::Branch(name) => {
            if name.is_empty() || name.starts_with('-') {
                bail!("invalid branch name: {name}");
            }
            git(None, &["check-ref-format", "--branch", name]).await?;
            None
        }
        Selection::Pr(number) => {
            let output = Command::new("gh")
                .args([
                    "pr",
                    "view",
                    &number.to_string(),
                    "--repo",
                    REPOSITORY,
                    "--json",
                    "headRefOid,state",
                ])
                .output()
                .await
                .wrap_err("gh is required to inspect the pull request")?;
            let bytes = successful(output, "inspect the pull request")?;
            let pr: PullRequest = serde_json::from_slice(&bytes)
                .wrap_err("gh returned invalid pull request metadata")?;
            if pr.state != "OPEN" {
                bail!(
                    "pull request #{number} is {}; refusing to build a stale head",
                    pr.state
                );
            }
            Some(pr.head_ref_oid)
        }
    };

    let checkout = tempfile::tempdir().wrap_err("failed to create source checkout")?;
    let root = checkout.path();
    git(Some(root), &["init", "--quiet"]).await?;
    git(Some(root), &["remote", "add", "origin", SOURCE_URL]).await?;
    eprintln!("fetching nanocodex {}...", selection.description());
    let reference = selection.reference();
    git(Some(root), &["fetch", "--depth", "1", "origin", &reference]).await?;
    git(
        Some(root),
        &["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    )
    .await?;
    let sha = String::from_utf8(git(Some(root), &["rev-parse", "HEAD"]).await?)
        .wrap_err("git returned an invalid source revision")?
        .trim()
        .to_owned();
    if let Some(expected) = expected_sha
        && sha != expected
    {
        bail!(
            "pull request head changed while fetching: expected {expected}, fetched {sha}; retry the update"
        );
    }

    let target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        std::env::current_dir()?.join(target)
    };
    for (package, binary, features) in [
        ("nanocodex-bin", "nanocodex", true),
        ("nanocodex2-bin", "nanocodex2", false),
    ] {
        eprintln!("compiling {binary} at {sha}...");
        let mut command = Command::new("cargo");
        command
            .current_dir(root)
            .env("CARGO_TARGET_DIR", &target)
            .env("VERGEN_GIT_SHA", &sha)
            .env("STABLE_GIT_COMMIT", &sha)
            .args([
                "build",
                "--locked",
                "--release",
                "--package",
                package,
                "--bin",
                binary,
            ]);
        if features {
            command.args(["--features", "tempo"]);
        }
        let status = command
            .status()
            .await
            .wrap_err_with(|| format!("failed to start cargo while compiling {binary}"))?;
        if !status.success() {
            bail!("cargo failed while compiling {binary}: {status}");
        }
    }
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let cli_path = target.join("release").join(format!("nanocodex{extension}"));
    let hand_path = target
        .join("release")
        .join(format!("nanocodex2{extension}"));
    if cfg!(target_os = "macos") {
        let status = Command::new("codesign")
            .args(["--force", "--sign", "-", "--entitlements"])
            .arg(root.join("nanocodex-vm.entitlements"))
            .arg(&hand_path)
            .status()
            .await
            .wrap_err("failed to sign the locally compiled Hand")?;
        if !status.success() {
            bail!("failed to sign the locally compiled Hand: {status}");
        }
    }
    local::verify_pair(&cli_path, &hand_path).await?;
    Ok(Build {
        sha,
        cli: std::fs::read(&cli_path).wrap_err("failed to read the compiled CLI")?,
        hand: std::fs::read(&hand_path).wrap_err("failed to read the compiled Hand")?,
    })
}

async fn git(cwd: Option<&Path>, args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .args(args)
        .output()
        .await
        .wrap_err("git is required to fetch Nanocodex source")?;
    successful(output, "fetch Nanocodex source")
}

fn successful(output: Output, action: &str) -> Result<Vec<u8>> {
    if !output.status.success() {
        return Err(eyre!(
            "failed to {action}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::DateTime;
use vergen::EmitBuilder;

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    emit_linked_worktree_ref_reruns();
    bundle_hand_computer_sources()?;

    EmitBuilder::builder()
        .build_timestamp()
        .git_describe(false, true, None)
        .git_sha(false)
        .emit_and_set()?;

    let sha = env_var("VERGEN_GIT_SHA")?;
    let sha_short = sha
        .get(..sha.len().min(10))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "VERGEN_GIT_SHA is empty"))?;
    let pkg_version = env_var("CARGO_PKG_VERSION")?;
    let tag_name = try_env_var("TAG_NAME").unwrap_or_else(|| String::from("dev"));
    let is_nightly = tag_name.contains("nightly");
    let is_stable = tag_name == pkg_version || tag_name == format!("v{pkg_version}");
    let suffix = if is_nightly {
        "-nightly"
    } else if is_stable {
        ""
    } else {
        "-dev"
    };
    if is_nightly {
        println!("cargo:rustc-env=NANOCODEX_IS_NIGHTLY=true");
    }

    let version = format!("{pkg_version}{suffix}");
    let build_timestamp = env_var("VERGEN_BUILD_TIMESTAMP")?;
    let build_timestamp_unix = DateTime::parse_from_rfc3339(&build_timestamp)?.timestamp();
    let profile = build_profile()?;

    println!(
        "cargo:rustc-env=NANOCODEX_SEMVER_VERSION={version}+{sha_short}.{build_timestamp_unix}.{profile}"
    );
    println!("cargo:rustc-env=NANOCODEX_SHORT_VERSION={version} ({sha_short} {build_timestamp})");

    let long_version = format!(
        "Version: {version}\nCommit SHA: {sha}\nBuild Timestamp: {build_timestamp} ({build_timestamp_unix})\nBuild Profile: {profile}"
    );
    for (index, line) in long_version.lines().enumerate() {
        println!("cargo:rustc-env=NANOCODEX_LONG_VERSION_{index}={line}");
    }

    Ok(())
}

// The SSH installer must be self-contained even when the CLI runs outside a
// checkout. Keep the named Docker build context tied to this CLI's source.
fn bundle_hand_computer_sources() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env_var("CARGO_MANIFEST_DIR")?)
        .join("../../crates/experimental/nanocodex-computer/runtime")
        .canonicalize()?;
    let mut files = Vec::new();
    for name in ["Cargo.toml", "Cargo.lock", "src", "extensions"] {
        collect_hand_sources(&root.join(name), &mut files)?;
    }
    files.sort();
    let mut source = String::from("&[\n");
    for file in files {
        let name = file
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/");
        source.push_str(&format!(
            "({name:?}, include_bytes!({:?})),\n",
            file.to_str().ok_or("non-UTF-8 source path")?
        ));
    }
    source.push_str("]\n");
    fs::write(
        PathBuf::from(env_var("OUT_DIR")?).join("hand_computer_sources.rs"),
        source,
    )?;
    Ok(())
}

fn collect_hand_sources(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    println!("cargo:rerun-if-changed={}", path.display());
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            collect_hand_sources(&entry?.path(), files)?;
        }
    } else if metadata.is_file() {
        files.push(path.to_owned());
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Hand sources must be ordinary files or directories",
        ));
    }
    Ok(())
}

fn emit_linked_worktree_ref_reruns() {
    let Ok(manifest_directory) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let workspace = PathBuf::from(manifest_directory)
        .parent()
        .and_then(|bin| bin.parent())
        .map(PathBuf::from);
    let Some(workspace) = workspace else {
        return;
    };
    let Some(reference) = git_stdout(&workspace, &["symbolic-ref", "-q", "HEAD"]) else {
        return;
    };
    if let Some(path) = git_stdout(&workspace, &["rev-parse", "--git-path", &reference]) {
        println!("cargo:rerun-if-changed={path}");
    }
    if let Some(path) = git_stdout(&workspace, &["rev-parse", "--git-path", "packed-refs"]) {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn git_stdout(workspace: &std::path::Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(arguments)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let output = String::from_utf8(output.stdout).ok()?;
    let output = output.trim();
    (!output.is_empty()).then(|| output.to_owned())
}

fn build_profile() -> Result<String, Box<dyn Error>> {
    let out_dir = PathBuf::from(env_var("OUT_DIR")?);
    out_dir
        .components()
        .rev()
        .nth(3)
        .and_then(|component| component.as_os_str().to_str())
        .map(String::from)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cannot derive the Cargo profile from {}", out_dir.display()),
            )
            .into()
        })
}

fn env_var(name: &str) -> Result<String, std::env::VarError> {
    println!("cargo:rerun-if-env-changed={name}");
    std::env::var(name)
}

fn try_env_var(name: &str) -> Option<String> {
    println!("cargo:rerun-if-env-changed={name}");
    std::env::var(name).ok()
}

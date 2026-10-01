//! Explicitly rooted, text-only workspace operations for a host-authorized Claude-style tool surface.
//!
//! Construct this module only after the host authorizes and isolates the workspace. The
//! path checks are defense in depth, not a substitute for OS-level isolation or permissions.

use regex::RegexBuilder;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{Read as _, Write as _},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const MAX_FILE: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 64 * 1024;
const MAX_VISITS: usize = 10_000;
const MAX_SEARCH_BYTES: u64 = 128 * 1024 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

/// A host-authorized directory used by text-only workspace tools.
///
/// The host must explicitly authorize and OS-isolate this root. In particular, path
/// validation cannot eliminate races with a hostile process concurrently swapping
/// directory entries; do not use this as a security boundary against such processes.
#[derive(Clone, Debug)]
pub struct ClaudeWorkspaceFiles {
    root: PathBuf,
    root_alias: PathBuf,
}

impl ClaudeWorkspaceFiles {
    /// Canonicalize an existing directory; no ambient/current workspace is assumed.
    pub fn new(root: impl AsRef<Path>) -> Result<Self, String> {
        let given = root.as_ref();
        let root_alias = if given.is_absolute() {
            given.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| format!("workspace current directory: {e}"))?
                .join(given)
        };
        let root = fs::canonicalize(given).map_err(|e| format!("workspace root: {e}"))?;
        if !root.is_dir() {
            return Err("workspace root is not a directory".into());
        }
        Ok(Self { root, root_alias })
    }

    /// Standalone JSON metadata for the five tools; no model-vendor contract is required.
    #[must_use]
    pub fn definitions() -> Vec<Value> {
        vec![
            json!({"name":"Read","description":"Read a UTF-8 workspace file with numbered lines.","input_schema":{"type":"object","properties":{"file_path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1}},"required":["file_path"],"additionalProperties":false}}),
            json!({"name":"Edit","description":"Replace exact text in a workspace file, requiring one occurrence unless replace_all is true.","input_schema":{"type":"object","properties":{"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["file_path","old_string","new_string"],"additionalProperties":false}}),
            json!({"name":"Write","description":"Atomically replace a UTF-8 workspace file, creating parent directories as needed.","input_schema":{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"],"additionalProperties":false}}),
            json!({"name":"Glob","description":"List matching workspace files using *, ? and ** wildcards.","input_schema":{"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"}},"required":["pattern"],"additionalProperties":false}}),
            json!({"name":"Grep","description":"Search UTF-8 files with a bounded Rust regex. Default output is matching file paths; glob supports only *, ? and **. Unsupported type filters are rejected.","input_schema":{"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"},"glob":{"type":"string","description":"Simple file glob: *, ? and ** only (no braces or character classes)."},"output_mode":{"type":"string","enum":["content","files_with_matches","count"],"default":"files_with_matches"},"-B":{"type":"integer","minimum":0,"maximum":2000},"-A":{"type":"integer","minimum":0,"maximum":2000},"-C":{"type":"integer","minimum":0,"maximum":2000},"context":{"type":"integer","minimum":0,"maximum":2000},"-n":{"type":"boolean","default":true},"-i":{"type":"boolean"},"-o":{"type":"boolean"},"head_limit":{"type":"integer","minimum":0,"default":250},"offset":{"type":"integer","minimum":0,"default":0},"multiline":{"type":"boolean"}},"required":["pattern"],"additionalProperties":false}}),
        ]
    }

    /// Alias for [`Self::definitions`].
    #[must_use]
    pub fn tool_schemas() -> Vec<Value> {
        Self::definitions()
    }

    /// Execute a named file operation, returning bounded text or a descriptive error.
    pub async fn execute(&self, name: &str, input: Value) -> Result<String, String> {
        let this = self.clone();
        let name = name.to_owned();
        tokio::task::spawn_blocking(move || this.execute_sync(&name, &input))
            .await
            .map_err(|e| format!("workspace task: {e}"))?
    }

    fn execute_sync(&self, name: &str, input: &Value) -> Result<String, String> {
        let allowed: &[&str] = match name {
            "Read" => &["file_path", "offset", "limit", "pages"],
            "Write" => &["file_path", "content"],
            "Edit" => &["file_path", "old_string", "new_string", "replace_all"],
            "Glob" => &["pattern", "path"],
            // Grep validates its larger option set below.
            "Grep" => return self.grep(input),
            _ => return Err(format!("unknown workspace tool: {name}")),
        };
        let fields = input
            .as_object()
            .ok_or("workspace input must be an object")?;
        if let Some(key) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(format!("unsupported {name} option: {key}"));
        }
        match name {
            "Read" => self.read(input),
            "Write" => self.write(input),
            "Edit" => self.edit(input),
            "Glob" => self.glob(input),
            "Grep" => self.grep(input),
            _ => Err(format!("unknown workspace tool: {name}")),
        }
    }

    fn field<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
        input
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("missing or invalid {key}"))
    }

    fn relative(&self, text: &str, allow_root: bool) -> Result<PathBuf, String> {
        if text.len() > 4096 {
            return Err("path exceeds 4096-byte limit".into());
        }
        let path = Path::new(text);
        let relative = if path.is_absolute() {
            path.strip_prefix(&self.root)
                .or_else(|_| path.strip_prefix(&self.root_alias))
                .map_err(|_| "absolute path outside workspace".to_string())?
        } else {
            path
        };
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            // A bare "." is allowed only as a search root.
            if !(allow_root && (text == "." || relative.as_os_str().is_empty())) {
                return Err("path must not contain traversal, root, or special components".into());
            }
        }
        if !allow_root && relative.as_os_str().is_empty() {
            return Err("file path is empty".into());
        }
        Ok(relative.to_path_buf())
    }

    fn existing(&self, text: &str) -> Result<(PathBuf, PathBuf), String> {
        let rel = self.relative(text, true)?;
        let target = self.root.join(&rel);
        let real = fs::canonicalize(target).map_err(|e| format!("path: {e}"))?;
        if !real.starts_with(&self.root) {
            return Err("symlink escapes workspace".into());
        }
        Ok((rel, real))
    }

    fn file(&self, text: &str) -> Result<(PathBuf, PathBuf), String> {
        let (rel, real) = self.existing(text)?;
        if !real.is_file() {
            return Err("path is not a regular file".into());
        }
        Ok((rel, real))
    }

    fn read_text(path: &Path) -> Result<String, String> {
        let f = fs::File::open(path).map_err(|e| format!("read: {e}"))?;
        let mut bytes = Vec::new();
        f.take((MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read: {e}"))?;
        if bytes.len() > MAX_FILE {
            return Err("file exceeds 1 MiB text limit".into());
        }
        String::from_utf8(bytes).map_err(|_| "file is not UTF-8 text".into())
    }

    fn read(&self, input: &Value) -> Result<String, String> {
        if input.get("pages").is_some() {
            return Err("Read pages is unsupported: PDF reading is not available".into());
        }
        let (_, path) = self.file(Self::field(input, "file_path")?)?;
        let content = Self::read_text(&path)?;
        let offset = input
            .get("offset")
            .map_or(Some(1), Value::as_u64)
            .ok_or("invalid offset")?;
        let limit = input
            .get("limit")
            .map_or(Some(2000), Value::as_u64)
            .ok_or("invalid limit")?;
        if offset == 0 || limit == 0 {
            return Err("offset and limit must be positive".into());
        }
        let mut out = String::new();
        for (i, line) in content
            .lines()
            .enumerate()
            .skip(offset.saturating_sub(1).min(usize::MAX as u64) as usize)
            .take(limit.min(2000) as usize)
        {
            if !push_bounded(&mut out, &format!("{}\t{}\n", i + 1, line)) {
                break;
            }
        }
        Ok(out)
    }

    fn write_target(&self, text: &str) -> Result<(PathBuf, PathBuf), String> {
        let rel = self.relative(text, false)?;
        let path = self.root.join(&rel);
        let parent = path.parent().ok_or("file has no parent")?;
        let mut current = self.root.clone();
        for component in rel.parent().into_iter().flat_map(Path::components) {
            current.push(component.as_os_str());
            match fs::symlink_metadata(&current) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err("symlink parent rejected".into());
                }
                Ok(meta) if !meta.is_dir() => return Err("parent is not a directory".into()),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current).map_err(|e| format!("create directory: {e}"))?
                }
                Err(e) => return Err(format!("check parent: {e}")),
            }
        }
        if fs::canonicalize(parent).map_err(|e| format!("parent: {e}"))? != parent {
            return Err("parent escapes workspace or uses a symlink".into());
        }
        reject_symlink_target(&path)?;
        Ok((rel, path))
    }

    fn write(&self, input: &Value) -> Result<String, String> {
        let content = Self::field(input, "content")?;
        if content.len() > MAX_FILE {
            return Err("content exceeds 1 MiB text limit".into());
        }
        let (rel, path) = self.write_target(Self::field(input, "file_path")?)?;
        atomic_write(&path, content)?;
        Ok(format!("Wrote {}", rel.display()))
    }

    fn edit(&self, input: &Value) -> Result<String, String> {
        let text = Self::field(input, "file_path")?;
        let old = Self::field(input, "old_string")?;
        let new = Self::field(input, "new_string")?;
        if old.is_empty() {
            return Err("old_string must not be empty".into());
        }
        let replace_all = input
            .get("replace_all")
            .map_or(Some(false), Value::as_bool)
            .ok_or("invalid replace_all")?;
        let (rel, existing) = self.file(text)?;
        let content = Self::read_text(&existing)?;
        let count = content.matches(old).count();
        if count == 0 {
            return Err("old_string not found".into());
        }
        if count != 1 && !replace_all {
            return Err(format!("old_string occurs {count} times; set replace_all"));
        }
        // Validate expansion before allocating: a tiny repeated match can otherwise
        // amplify a bounded input into an unbounded replacement allocation.
        let replacements = if replace_all { count } else { 1 };
        let updated_len = content.len() - old.len() * replacements;
        let updated_len = new
            .len()
            .checked_mul(replacements)
            .and_then(|added| updated_len.checked_add(added))
            .filter(|&len| len <= MAX_FILE)
            .ok_or("edited content exceeds 1 MiB text limit")?;
        let updated = if replace_all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        debug_assert_eq!(updated.len(), updated_len);
        let (_, path) = self.write_target(text)?;
        // Best-effort stale-read check before the atomic replacement.
        if Self::read_text(&path)? != content {
            return Err("file changed during edit".into());
        }
        atomic_write(&path, &updated)?;
        Ok(format!("Edited {} ({count} replacement(s))", rel.display()))
    }

    fn search_root(&self, input: &Value) -> Result<(PathBuf, PathBuf), String> {
        let text = input
            .get("path")
            .map_or(Some("."), Value::as_str)
            .ok_or("invalid path")?;
        self.existing(text)
    }

    fn walk(&self, path: &Path) -> Result<Vec<PathBuf>, String> {
        let mut stack = vec![path.to_path_buf()];
        let mut files = Vec::new();
        let mut visits = 0;
        while let Some(next) = stack.pop() {
            visits += 1;
            if visits > MAX_VISITS {
                return Err("search exceeds 10000 entries".into());
            }
            let meta = fs::symlink_metadata(&next).map_err(|e| format!("walk: {e}"))?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_file() {
                files.push(next);
            } else if meta.is_dir() {
                for entry in fs::read_dir(&next).map_err(|e| format!("walk: {e}"))? {
                    // Count discovered entries before enqueuing, not only after
                    // popping: one wide directory must not bypass the memory cap.
                    if visits + stack.len() >= MAX_VISITS {
                        return Err("search exceeds 10000 entries".into());
                    }
                    stack.push(entry.map_err(|e| format!("walk: {e}"))?.path());
                }
            }
        }
        files.sort();
        Ok(files)
    }

    fn glob(&self, input: &Value) -> Result<String, String> {
        let raw_pattern = Self::field(input, "pattern")?;
        let pattern = if Path::new(raw_pattern).is_absolute() {
            self.relative(raw_pattern, false)?
                .to_str()
                .ok_or("pattern is not UTF-8")?
                .to_owned()
        } else {
            raw_pattern.to_owned()
        };
        let matcher = glob_regex(&pattern)?;
        // An explicit literal prefix denoting a symlink escape is an error, not an empty match.
        let literal_prefix = pattern
            .split('/')
            .take_while(|part| !part.contains(['*', '?']))
            .collect::<Vec<_>>()
            .join("/");
        let (_, root) = self.search_root(input)?;
        if !literal_prefix.is_empty() {
            let candidate = root.join(&literal_prefix);
            if candidate.exists()
                && !fs::canonicalize(&candidate)
                    .map_err(|e| format!("glob path: {e}"))?
                    .starts_with(&self.root)
            {
                return Err("glob symlink escapes workspace".into());
            }
        }
        let mut out = String::new();
        for file in self.walk(&root)? {
            let rel = file
                .strip_prefix(&root)
                .map_err(|_| "search path changed")?
                .to_string_lossy();
            if matcher.is_match(&rel) {
                let shown = file
                    .strip_prefix(&self.root)
                    .map_err(|_| "search escaped workspace")?
                    .display();
                if !push_bounded(&mut out, &format!("{shown}\n")) {
                    break;
                }
            }
        }
        Ok(out)
    }

    fn grep(&self, input: &Value) -> Result<String, String> {
        let fields = input.as_object().ok_or("Grep input must be an object")?;
        for key in fields.keys() {
            if !matches!(
                key.as_str(),
                "pattern"
                    | "path"
                    | "glob"
                    | "output_mode"
                    | "-B"
                    | "-A"
                    | "-C"
                    | "context"
                    | "-n"
                    | "-i"
                    | "-o"
                    | "head_limit"
                    | "offset"
                    | "multiline"
                    | "case_sensitive"
            ) {
                return Err(format!("unsupported Grep option: {key}"));
            }
        }
        let pattern = Self::field(input, "pattern")?;
        if pattern.is_empty() || pattern.len() > 4096 {
            return Err("pattern must be 1 to 4096 bytes".into());
        }
        let mode = input
            .get("output_mode")
            .map_or(Some("files_with_matches"), Value::as_str)
            .ok_or("invalid output_mode")?;
        if !matches!(mode, "content" | "files_with_matches" | "count") {
            return Err("invalid output_mode".into());
        }
        let insensitive = grep_bool(input, "-i", false)?;
        if input.get("case_sensitive").is_some() && input.get("-i").is_some() {
            return Err("case_sensitive conflicts with -i".into());
        }
        // Retain the original, unadvertised spelling for old callers.
        let sensitive = grep_bool(input, "case_sensitive", !insensitive)?;
        let only_matching = grep_bool(input, "-o", false)?;
        let line_numbers = grep_bool(input, "-n", true)?;
        let multiline = grep_bool(input, "multiline", false)?;
        let before = grep_number(input, "-B", 0, 2000)?;
        let after = grep_number(input, "-A", 0, 2000)?;
        if input.get("-C").is_some() && input.get("context").is_some() {
            return Err("-C conflicts with context".into());
        }
        let context = if input.get("-C").is_some() {
            grep_number(input, "-C", 0, 2000)?
        } else {
            grep_number(input, "context", 0, 2000)?
        };
        let before = if input.get("-B").is_some() {
            before
        } else {
            context
        };
        let after = if input.get("-A").is_some() {
            after
        } else {
            context
        };
        let offset = grep_number(input, "offset", 0, u64::MAX)?;
        let head_limit = grep_number(input, "head_limit", 250, u64::MAX)?;
        if mode != "content"
            && (input.get("-B").is_some()
                || input.get("-A").is_some()
                || input.get("-C").is_some()
                || input.get("context").is_some()
                || input.get("-n").is_some()
                || input.get("-o").is_some())
        {
            return Err("context, -n, and -o require output_mode content".into());
        }
        if only_matching && (before > 0 || after > 0 || multiline) {
            return Err("-o cannot be combined with context or multiline".into());
        }
        let glob = match input.get("glob") {
            Some(value) => Some(value.as_str().ok_or("invalid glob")?),
            None => None,
        };
        let glob_matcher = glob.map(glob_regex).transpose()?;
        let re = RegexBuilder::new(pattern)
            .case_insensitive(!sensitive)
            .multi_line(multiline)
            .dot_matches_new_line(multiline)
            .size_limit(4 * 1024 * 1024)
            .build()
            .map_err(|e| format!("invalid or oversized regex: {e}"))?;
        let (_, root) = self.search_root(input)?;
        let mut out = String::new();
        let mut searched_bytes = 0u64;
        let mut skipped = 0u64;
        let mut yielded = 0u64;
        for file in self.walk(&root)? {
            let shown = file
                .strip_prefix(&self.root)
                .map_err(|_| "search escaped workspace")?
                .to_string_lossy();
            if let (Some(glob), Some(matcher)) = (glob, &glob_matcher) {
                let relative = file
                    .strip_prefix(&root)
                    .map_err(|_| "search path changed")?;
                let target = if glob.contains('/') && !relative.as_os_str().is_empty() {
                    relative.to_string_lossy()
                } else {
                    file.file_name().unwrap_or_default().to_string_lossy()
                };
                if !matcher.is_match(&target) {
                    continue;
                }
            }
            let size = fs::metadata(&file)
                .map_err(|e| format!("search metadata: {e}"))?
                .len();
            searched_bytes = searched_bytes.saturating_add(size.min((MAX_FILE + 1) as u64));
            if searched_bytes > MAX_SEARCH_BYTES {
                return Err("search exceeds 128 MiB scan limit".into());
            }
            let Ok(contents) = Self::read_text(&file) else {
                continue;
            };
            let lines: Vec<&str> = contents.lines().collect();
            let mut hits = vec![false; lines.len()];
            if multiline {
                // A match spanning lines marks each touched line. Byte offsets are UTF-8 safe.
                let starts: Vec<usize> = std::iter::once(0)
                    .chain(contents.match_indices('\n').map(|(i, _)| i + 1))
                    .collect();
                for found in re.find_iter(&contents) {
                    let first = starts
                        .partition_point(|&s| s <= found.start())
                        .saturating_sub(1);
                    let last_byte = found.end().saturating_sub(1).max(found.start());
                    let last = starts
                        .partition_point(|&s| s <= last_byte)
                        .saturating_sub(1);
                    for hit in hits.iter_mut().take(last.saturating_add(1)).skip(first) {
                        *hit = true;
                    }
                }
            } else {
                for (line, hit) in lines.iter().zip(&mut hits) {
                    *hit = re.is_match(line);
                }
            }
            if mode != "content" {
                let count = hits.iter().filter(|&&hit| hit).count();
                if count == 0 {
                    continue;
                }
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                if head_limit != 0 && yielded >= head_limit {
                    return Ok(out);
                }
                let line = if mode == "count" {
                    format!("{shown}:{count}\n")
                } else {
                    format!("{shown}\n")
                };
                if !push_bounded(&mut out, &line) {
                    return Ok(out);
                }
                yielded += 1;
                continue;
            }
            if only_matching {
                for (index, line) in lines.iter().enumerate() {
                    for found in re.find_iter(line) {
                        if skipped < offset {
                            skipped += 1;
                            continue;
                        }
                        if head_limit != 0 && yielded >= head_limit {
                            return Ok(out);
                        }
                        let prefix = if line_numbers {
                            format!("{shown}:{}:", index + 1)
                        } else {
                            format!("{shown}:")
                        };
                        if !push_bounded(&mut out, &format!("{prefix}{}\n", found.as_str())) {
                            return Ok(out);
                        }
                        yielded += 1;
                    }
                }
                continue;
            }
            let mut selected = vec![false; lines.len()];
            for (index, hit) in hits.iter().enumerate() {
                if !hit {
                    continue;
                }
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                if head_limit != 0 && yielded >= head_limit {
                    break;
                }
                selected[index] = true;
                yielded += 1;
            }
            let mut emit = vec![false; lines.len()];
            for (index, &hit) in selected.iter().enumerate() {
                if hit {
                    let start = index.saturating_sub(before as usize);
                    let end = index
                        .saturating_add(after as usize)
                        .saturating_add(1)
                        .min(lines.len());
                    emit[start..end].fill(true);
                }
            }
            let mut previous = None;
            for (index, line) in lines.iter().enumerate() {
                if !emit[index] {
                    continue;
                }
                if let Some(prev) = previous
                    && index > prev + 1
                    && !push_bounded(&mut out, "--\n")
                {
                    return Ok(out);
                }
                let separator = if selected[index] { ':' } else { '-' };
                let result = if line_numbers {
                    format!("{shown}{separator}{}{separator}{line}\n", index + 1)
                } else {
                    format!("{shown}{separator}{line}\n")
                };
                if !push_bounded(&mut out, &result) {
                    return Ok(out);
                }
                previous = Some(index);
            }
            if head_limit != 0 && yielded >= head_limit {
                return Ok(out);
            }
        }
        Ok(out)
    }
}

fn grep_bool(input: &Value, key: &str, default: bool) -> Result<bool, String> {
    input
        .get(key)
        .map_or(Some(default), Value::as_bool)
        .ok_or_else(|| format!("invalid {key}"))
}

fn grep_number(input: &Value, key: &str, default: u64, max: u64) -> Result<u64, String> {
    let value = input
        .get(key)
        .map_or(Some(default), Value::as_u64)
        .ok_or_else(|| format!("invalid {key}"))?;
    if value > max {
        return Err(format!("{key} exceeds {max}"));
    }
    Ok(value)
}

fn reject_symlink_target(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("symlink target rejected".into()),
        Ok(meta) if !meta.is_file() => Err("target is not a regular file".into()),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("check target: {e}")),
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("file has no parent")?;
    let mut temp = None;
    for _ in 0..16 {
        let name = format!(
            ".nanocodex-{}-{}.tmp",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        );
        let candidate = parent.join(name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                temp = Some((candidate, file));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("create temp file: {e}")),
        }
    }
    let (temp_path, mut file) = temp.ok_or("could not allocate temp file")?;
    let result = (|| {
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
        file.sync_all().map_err(|e| format!("sync: {e}"))?;
        drop(file);
        reject_symlink_target(path)?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&temp_path, meta.permissions())
                .map_err(|e| format!("permissions: {e}"))?;
        }
        fs::rename(&temp_path, path).map_err(|e| format!("rename: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn push_bounded(output: &mut String, line: &str) -> bool {
    if output.len() + line.len() > MAX_OUTPUT {
        const MARKER: &str = "[output truncated]\n";
        if output.len() + MARKER.len() <= MAX_OUTPUT {
            output.push_str(MARKER);
        }
        return false;
    }
    output.push_str(line);
    true
}

fn validate_pattern(pattern: &str) -> Result<(), String> {
    if pattern.is_empty()
        || pattern.len() > 512
        || pattern.starts_with('/')
        || pattern.split('/').any(|part| part == ".." || part == ".")
    {
        return Err("invalid glob pattern or traversal".into());
    }
    Ok(())
}

// Compile once per search. Regex Unicode semantics make ? one character, and
// its bounded automaton avoids recursive matching proportional to path length.
fn glob_regex(pattern: &str) -> Result<regex::Regex, String> {
    validate_pattern(pattern)?;
    if pattern.contains(['[', ']', '{', '}', '\\']) {
        return Err("unsupported glob syntax: only *, ? and ** are available".into());
    }
    let mut expression = String::from("\\A");
    let mut chars = pattern.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                if chars.peek() == Some(&'/') {
                    chars.next();
                    expression.push_str("(?:.*/)?");
                } else {
                    expression.push_str(".*");
                }
            }
            '*' => expression.push_str("[^/]*"),
            '?' => expression.push_str("[^/]"),
            literal => expression.push_str(&regex::escape(&literal.to_string())),
        }
    }
    expression.push_str("\\z");
    RegexBuilder::new(&expression)
        .dot_matches_new_line(true)
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| format!("invalid or oversized glob: {e}"))
}

#[cfg(test)]
mod tests {
    use super::ClaudeWorkspaceFiles;
    use serde_json::json;
    use std::fs;

    #[tokio::test]
    async fn mutation_options_and_expansion_fail_without_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        let path = dir.path().join("original");
        fs::write(&path, "aa").unwrap();
        for (name, input) in [
            (
                "Write",
                json!({"file_path":"original","content":"bad","append":true}),
            ),
            (
                "Edit",
                json!({"file_path":"original","old_string":"aa","new_string":"bad","replaceAll":true}),
            ),
            (
                "Edit",
                json!({"file_path":"original","old_string":"a","new_string":"x".repeat(super::MAX_FILE),"replace_all":true}),
            ),
        ] {
            assert!(
                files.execute(name, input).await.is_err(),
                "{name} accepted invalid mutation"
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "aa");
        }
        files.execute("Edit", json!({"file_path":"original","old_string":"a","new_string":"é".repeat(super::MAX_FILE / 4),"replace_all":true})).await.unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), super::MAX_FILE as u64);
    }

    #[tokio::test]
    async fn scoped_search_and_unicode_glob() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        fs::write(dir.path().join("src/nested/é.rs"), "needle").unwrap();
        assert_eq!(
            files
                .execute(
                    "Grep",
                    json!({"path":"src","glob":"nested/*.rs","pattern":"needle"})
                )
                .await
                .unwrap(),
            "src/nested/é.rs\n"
        );
        assert_eq!(
            files
                .execute(
                    "Grep",
                    json!({"path":"src/nested/é.rs","glob":"*.rs","pattern":"needle"})
                )
                .await
                .unwrap(),
            "src/nested/é.rs\n"
        );
        assert_eq!(
            files
                .execute("Glob", json!({"path":"src","pattern":"**/?.rs"}))
                .await
                .unwrap(),
            "src/nested/é.rs\n"
        );
        assert!(
            files
                .execute("Glob", json!({"pattern":"**/*.{rs,txt}"}))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn round_trip_and_exact_edit() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        files
            .execute(
                "Write",
                json!({"file_path":"a/b.txt","content":"red\nblue\n"}),
            )
            .await
            .unwrap();
        assert_eq!(
            files
                .execute("Read", json!({"file_path":"a/b.txt"}))
                .await
                .unwrap(),
            "1\tred\n2\tblue\n"
        );
        assert!(
            files
                .execute(
                    "Edit",
                    json!({"file_path":"a/b.txt","old_string":"red","new_string":"green"})
                )
                .await
                .is_ok()
        );
        assert!(
            files
                .execute("Read", json!({"file_path":"a/b.txt"}))
                .await
                .unwrap()
                .contains("green")
        );
        assert!(
            files
                .execute("Glob", json!({"pattern":"**/*.txt"}))
                .await
                .unwrap()
                .contains("a/b.txt")
        );
        assert!(
            files
                .execute("Grep", json!({"pattern":"green","output_mode":"content"}))
                .await
                .unwrap()
                .contains("a/b.txt:1:green")
        );
    }

    #[tokio::test]
    async fn grep_uses_bounded_regular_expressions() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        files
            .execute(
                "Write",
                json!({"file_path":"a.txt","content":"Alpha 42\nbeta 99\n"}),
            )
            .await
            .unwrap();
        let found = files
            .execute(
                "Grep",
                json!({"pattern":"^alpha [0-9]+$","-i":true,"output_mode":"content"}),
            )
            .await
            .unwrap();
        assert_eq!(found, "a.txt:1:Alpha 42\n");
        assert!(files.execute("Grep", json!({"pattern":"["})).await.is_err());
    }

    #[tokio::test]
    async fn grep_modes_filters_pagination_and_context() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        files
            .execute(
                "Write",
                json!({"file_path":"src/a.rs","content":"before\nHit Hit\nafter\nspacer\nHit\n"}),
            )
            .await
            .unwrap();
        files
            .execute("Write", json!({"file_path":"src/b.txt","content":"hit\n"}))
            .await
            .unwrap();
        files
            .execute("Write", json!({"file_path":"src/c.rs","content":"hit\n"}))
            .await
            .unwrap();
        assert_eq!(
            files
                .execute("Grep", json!({"pattern":"Hit", "glob":"*.rs"}))
                .await
                .unwrap(),
            "src/a.rs\n"
        );
        assert_eq!(
            files
                .execute(
                    "Grep",
                    json!({"pattern":"hit", "-i":true,"glob":"*.rs","output_mode":"count"})
                )
                .await
                .unwrap(),
            "src/a.rs:2\nsrc/c.rs:1\n"
        );
        assert_eq!(files.execute("Grep", json!({"pattern":"hit", "-i":true,"output_mode":"files_with_matches","offset":1,"head_limit":1})).await.unwrap(),
            "src/b.txt\n");
        assert_eq!(
            files
                .execute(
                    "Grep",
                    json!({"pattern":"Hit", "output_mode":"content","-C":1,"head_limit":1})
                )
                .await
                .unwrap(),
            "src/a.rs-1-before\nsrc/a.rs:2:Hit Hit\nsrc/a.rs-3-after\n"
        );
        assert_eq!(files.execute("Grep", json!({"pattern":"Hit", "output_mode":"content","-o":true,"-n":false,"head_limit":2})).await.unwrap(),
            "src/a.rs:Hit\nsrc/a.rs:Hit\n");
        assert_eq!(
            files
                .execute(
                    "Grep",
                    json!({"pattern":"Hit", "output_mode":"content","offset":1,"head_limit":1})
                )
                .await
                .unwrap(),
            "src/a.rs:5:Hit\n"
        );
    }

    #[tokio::test]
    async fn grep_multiline_and_rejected_options() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        files
            .execute(
                "Write",
                json!({"file_path":"a.txt","content":"start\nmiddle\nend\n"}),
            )
            .await
            .unwrap();
        assert_eq!(
            files
                .execute(
                    "Grep",
                    json!({"pattern":"start.*end","multiline":true,"output_mode":"content"})
                )
                .await
                .unwrap(),
            "a.txt:1:start\na.txt:2:middle\na.txt:3:end\n"
        );
        for bad in [
            json!({"pattern":"x", "type":"rust"}),
            json!({"pattern":"x", "glob":"*.{rs,txt}"}),
            json!({"pattern":"x", "output_mode":"content", "-o":true,"multiline":true}),
            json!({"pattern":"x", "output_mode":"count", "-n":false}),
            json!({"pattern":"x", "-A":-1}),
            json!({"pattern":"x", "head_limit":"10"}),
        ] {
            assert!(files.execute("Grep", bad).await.is_err());
        }
        assert!(
            files
                .execute("Read", json!({"file_path":"a.txt", "pages":"1-2"}))
                .await
                .is_err()
        );
        let schema = ClaudeWorkspaceFiles::definitions();
        let grep = schema.iter().find(|s| s["name"] == "Grep").unwrap();
        assert!(grep["input_schema"]["properties"].get("type").is_none());
        assert!(
            grep["input_schema"]["properties"]
                .get("multiline")
                .is_some()
        );
        assert!(
            schema.iter().find(|s| s["name"] == "Read").unwrap()["input_schema"]["properties"]
                .get("pages")
                .is_none()
        );
    }

    #[tokio::test]
    async fn reject_escape_and_ambiguous_edit() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "private").unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        for path in [
            "../secret.txt",
            outside.path().join("secret.txt").to_str().unwrap(),
        ] {
            assert!(
                files
                    .execute("Read", json!({"file_path": path}))
                    .await
                    .is_err()
            );
            assert!(
                files
                    .execute("Write", json!({"file_path": path,"content":"bad"}))
                    .await
                    .is_err()
            );
        }
        files
            .execute("Write", json!({"file_path":"dupe","content":"aa aa"}))
            .await
            .unwrap();
        assert!(
            files
                .execute(
                    "Edit",
                    json!({"file_path":"dupe","old_string":"aa","new_string":"bb"})
                )
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("dupe")).unwrap(),
            "aa aa"
        );
        files
            .execute(
                "Edit",
                json!({"file_path":"dupe","old_string":"aa","new_string":"bb","replace_all":true}),
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("dupe")).unwrap(),
            "bb bb"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_escape_is_blocked_for_every_operation() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "private").unwrap();
        symlink(outside.path(), dir.path().join("link")).unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        assert!(
            files
                .execute("Read", json!({"file_path":"link/secret"}))
                .await
                .is_err()
        );
        assert!(
            files
                .execute("Write", json!({"file_path":"link/new","content":"bad"}))
                .await
                .is_err()
        );
        assert!(
            files
                .execute("Glob", json!({"pattern":"link/**"}))
                .await
                .is_err()
        );
        assert!(
            files
                .execute("Grep", json!({"pattern":"private","path":"link"}))
                .await
                .is_err()
        );
        assert!(!outside.path().join("new").exists());
    }

    #[tokio::test]
    async fn absolute_inside_root_and_output_limits() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        let path = dir.path().join("inside.txt");
        files
            .execute(
                "Write",
                json!({"file_path":path,"content":"hit".repeat(50_000)}),
            )
            .await
            .unwrap();
        let read = files
            .execute("Read", json!({"file_path":path,"limit":50_000}))
            .await
            .unwrap();
        assert!(read.len() <= 64 * 1024);
        assert!(read.contains("[output truncated]"));
        let grep = files
            .execute(
                "Grep",
                json!({"pattern":"hit","path":path,"output_mode":"content"}),
            )
            .await
            .unwrap();
        assert!(grep.len() <= 64 * 1024);
        assert!(
            files
                .execute(
                    "Glob",
                    json!({"pattern":format!("{}/*.txt",dir.path().display())})
                )
                .await
                .unwrap()
                .contains("inside.txt")
        );
    }

    #[tokio::test]
    async fn limits_and_invalid_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let files = ClaudeWorkspaceFiles::new(dir.path()).unwrap();
        assert!(
            files
                .execute(
                    "Write",
                    json!({"file_path":"huge","content":"x".repeat(1_048_577)})
                )
                .await
                .is_err()
        );
        assert!(
            files
                .execute("Read", json!({"file_path":"missing"}))
                .await
                .is_err()
        );
        assert!(
            files
                .execute("Glob", json!({"pattern":"../**"}))
                .await
                .is_err()
        );
        assert!(files.execute("Nope", json!({})).await.is_err());
        assert_eq!(ClaudeWorkspaceFiles::tool_schemas().len(), 5);
    }
}

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_RECORD_BYTES: usize = 4 * 1024;
pub const MAX_JOURNAL_BYTES: u64 = 256 * 1024;
pub const MAX_ARCHIVES: usize = 3;

const MAX_ID_BYTES: usize = 256;
const MAX_EVENT_BYTES: usize = 64;
const MAX_PROJECT_BYTES: usize = 256;
const MAX_NAVIGATION_BYTES: usize = 64;
const LOCK_TIMEOUT: Duration = Duration::from_millis(500);
const LOCK_WAIT: Duration = Duration::from_millis(5);
const ENTRYPOINTS: [&str; 2] = ["claude-desktop", "cli"];
const SESSION_SOURCES: [&str; 5] = ["startup", "resume", "clear", "compact", "fork"];
const END_REASONS: [&str; 5] = ["clear", "resume", "logout", "prompt_input_exit", "other"];

#[derive(Debug)]
pub enum HelperError {
    InvalidArguments,
    InvalidInput,
    Io,
}

#[derive(Debug)]
struct Arguments {
    provider: String,
    data_dir: PathBuf,
}

#[derive(Debug, Serialize)]
struct ReducedEvent {
    schema_version: u8,
    provider: String,
    event_name: String,
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elicitation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notification_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_hook_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entrypoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_subagent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_reason: Option<String>,
}

/// Parse, reduce, and append one hook payload. Errors are intentionally returned
/// only for tests and callers that want observability; the binary suppresses all
/// errors and exits successfully.
pub fn run<I, R>(args: I, mut input: R) -> Result<(), HelperError>
where
    I: IntoIterator<Item = String>,
    R: Read,
{
    let args = parse_arguments(args)?;
    let payload = read_bounded(&mut input)?;
    let value: Value = serde_json::from_slice(&payload).map_err(|_| HelperError::InvalidInput)?;
    let event = reduce_event(&args.provider, &value).ok_or(HelperError::InvalidInput)?;
    append_event(&args.data_dir, &event).map_err(|_| HelperError::Io)
}

fn parse_arguments<I>(args: I) -> Result<Arguments, HelperError>
where
    I: IntoIterator<Item = String>,
{
    let mut provider = None;
    let mut data_dir = None;
    let mut values = args.into_iter();
    while let Some(arg) = values.next() {
        match arg.as_str() {
            "--provider" => provider = values.next(),
            "--data-dir" => data_dir = values.next().map(PathBuf::from),
            _ => return Err(HelperError::InvalidArguments),
        }
    }

    let provider = provider.filter(|value| value == "codex" || value == "claude");
    let data_dir = data_dir.filter(|path| path.is_absolute());
    match (provider, data_dir) {
        (Some(provider), Some(data_dir)) => Ok(Arguments { provider, data_dir }),
        _ => Err(HelperError::InvalidArguments),
    }
}

fn read_bounded<R: Read>(input: &mut R) -> Result<Vec<u8>, HelperError> {
    let mut bytes = Vec::with_capacity(MAX_INPUT_BYTES.min(8 * 1024));
    input
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| HelperError::Io)?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(HelperError::InvalidInput);
    }
    Ok(bytes)
}

fn reduce_event(provider: &str, value: &Value) -> Option<ReducedEvent> {
    let object = value.as_object()?;
    let event_name = string_field(object, "hook_event_name", MAX_EVENT_BYTES)?;
    if !is_allowed_event(&event_name) {
        return None;
    }

    let session_id = string_field(object, "session_id", MAX_ID_BYTES)?;
    let turn_id = string_field(object, "turn_id", MAX_ID_BYTES);
    let prompt_id = string_field(object, "prompt_id", MAX_ID_BYTES);
    let elicitation_id = matches!(event_name.as_str(), "Elicitation" | "ElicitationResult")
        .then(|| string_field(object, "elicitation_id", MAX_ID_BYTES))
        .flatten();
    let tool_call_id = if provider == "codex" {
        string_field(object, "tool_call_id", MAX_ID_BYTES)
    } else {
        string_field(object, "tool_use_id", MAX_ID_BYTES)
    };
    let tool_name = string_field(object, "tool_name", MAX_NAVIGATION_BYTES)
        .filter(|value| value == "AskUserQuestion" || value == "request_user_input");

    let timestamp = now_millis();
    let (project_name, project_id) = project_metadata(object);
    let notification_type = (event_name == "Notification")
        .then(|| string_field(object, "notification_type", MAX_NAVIGATION_BYTES))
        .flatten()
        .filter(|value| {
            matches!(
                value.as_str(),
                "permission_prompt"
                    | "idle_prompt"
                    | "auth_success"
                    | "elicitation_dialog"
                    | "elicitation_complete"
                    | "elicitation_response"
            )
        });
    let stop_hook_active = object.get("stop_hook_active").and_then(Value::as_bool);
    let (host, entrypoint) = host_identity();
    // The entrypoint marker belongs to Claude Code; a Codex hook launched from
    // inside a Claude session would inherit it and must not record it.
    let entrypoint = entrypoint.filter(|_| provider == "claude");
    // Subagent hooks reuse the parent session ID and add an agent ID. Only the
    // fact that one is present is kept, never the ID itself, and no bound is
    // applied because a dropped marker would fail unsafe.
    let is_subagent = object
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
        .then_some(true);
    let session_source = (event_name == "SessionStart")
        .then(|| string_field(object, "source", MAX_NAVIGATION_BYTES))
        .flatten()
        .filter(|value| SESSION_SOURCES.contains(&value.as_str()));
    let end_reason = (event_name == "SessionEnd")
        .then(|| string_field(object, "reason", MAX_NAVIGATION_BYTES))
        .flatten()
        .filter(|value| END_REASONS.contains(&value.as_str()));

    Some(ReducedEvent {
        schema_version: 1,
        provider: provider.to_owned(),
        event_name,
        session_id,
        turn_id,
        prompt_id,
        elicitation_id,
        tool_call_id,
        tool_name,
        timestamp,
        project_name,
        project_id,
        notification_type,
        stop_hook_active,
        host,
        entrypoint,
        is_subagent,
        session_source,
        end_reason,
    })
}

/// Launching applications recognised from `__CFBundleIdentifier`.
fn host_name(bundle: &str) -> Option<&'static str> {
    Some(match bundle {
        "com.anthropic.claudefordesktop" => "claude-desktop",
        "com.apple.Terminal" => "terminal",
        "com.googlecode.iterm2" => "iterm2",
        "com.mitchellh.ghostty" => "ghostty",
        "dev.warp.Warp-Stable" => "warp",
        _ => return None,
    })
}

/// Hook processes inherit the launching application's environment. Two
/// variables identify the host: macOS sets `__CFBundleIdentifier` for
/// GUI-launched processes, and Claude Code sets `CLAUDE_CODE_ENTRYPOINT`. These
/// are the only variables read. Only exact allowlisted values produce a field;
/// anything else, including an unknown terminal or an IDE, is omitted rather
/// than recorded.
fn host_identity() -> (Option<String>, Option<String>) {
    let host = std::env::var("__CFBundleIdentifier")
        .ok()
        .and_then(|value| host_name(value.trim()))
        .map(str::to_owned);
    let entrypoint = std::env::var("CLAUDE_CODE_ENTRYPOINT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| ENTRYPOINTS.contains(&value.as_str()));
    (host, entrypoint)
}

fn string_field(
    object: &serde_json::Map<String, Value>,
    name: &str,
    max_bytes: usize,
) -> Option<String> {
    let value = object.get(name)?.as_str()?.trim();
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_owned())
}

fn project_metadata(object: &serde_json::Map<String, Value>) -> (Option<String>, Option<String>) {
    let cwd = string_field(object, "cwd", 4 * MAX_PROJECT_BYTES);
    let (cwd_name, project_id) = cwd
        .filter(|path| Path::new(path).is_absolute())
        .map(|path| {
            let normalized = normalize_absolute_path(Path::new(&path));
            let name = Path::new(&normalized)
                .components()
                .filter_map(|component| match component {
                    Component::Normal(value) => value.to_str(),
                    _ => None,
                })
                .next_back()
                .and_then(|name| bounded_text(name, MAX_PROJECT_BYTES));
            (name, Some(sha256_id(&normalized)))
        })
        .unwrap_or((None, None));
    (cwd_name, project_id)
}

fn normalize_absolute_path(path: &Path) -> String {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => components.clear(),
            Component::CurDir => {}
            Component::ParentDir => {
                components.pop();
            }
            Component::Normal(value) => components.push(value.to_string_lossy().into_owned()),
            Component::Prefix(prefix) => {
                components.push(prefix.as_os_str().to_string_lossy().into_owned())
            }
        }
    }
    if components.is_empty() {
        return "/".to_owned();
    }
    format!("/{}", components.join("/"))
}

fn sha256_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut result = String::with_capacity(64);
    for byte in digest {
        result.push_str(&format!("{byte:02x}"));
    }
    result
}

fn bounded_text(value: &str, max_bytes: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_owned())
}

fn is_allowed_event(name: &str) -> bool {
    matches!(
        name,
        "SessionStart"
            | "SessionEnd"
            | "UserPromptSubmit"
            | "PreToolUse"
            | "PostToolUse"
            | "PostToolUseFailure"
            | "PermissionRequest"
            | "Notification"
            | "Stop"
            | "StopFailure"
            | "Elicitation"
            | "ElicitationResult"
    )
}

fn append_event(data_dir: &Path, event: &ReducedEvent) -> io::Result<()> {
    ensure_private_directory(data_dir)?;
    let journals = data_dir.join("journals");
    ensure_private_directory(&journals)?;
    let provider_dir = journals.join(&event.provider);
    ensure_private_directory(&provider_dir)?;

    let identifier = path_identifier(&event.provider, &event.session_id);
    let journal = provider_dir.join(format!("{identifier}.jsonl"));
    let lock = provider_dir.join(format!("{identifier}.lock"));
    let line = serde_json::to_vec(event).map_err(|_| io::Error::other("serialize"))?;
    if line.len() + 1 > MAX_RECORD_BYTES {
        return Ok(());
    }

    let _guard = JournalLock::acquire(&lock)?;
    safe_journal_set(&journal)?;
    repair_unterminated_tail(&journal)?;
    let current_size = fs::symlink_metadata(&journal)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if current_size.saturating_add((line.len() + 1) as u64) > MAX_JOURNAL_BYTES {
        rotate(&journal)?;
    }

    let mut options = OpenOptions::new();
    options.create(true).append(true).write(true);
    add_no_follow(&mut options);
    let mut file = options.open(&journal)?;
    set_private_file_permissions(&file)?;
    let mut record = line;
    record.push(b'\n');
    file.write_all(&record)?;
    file.sync_data()
}

fn repair_unterminated_tail(journal: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(journal) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(io::Error::other("unsafe journal path"));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    add_no_follow(&mut options);
    let mut file = options.open(journal)?;
    let length = file.metadata()?.len();
    if length > MAX_JOURNAL_BYTES {
        return Err(io::Error::other("journal exceeds bound"));
    }
    let mut position = length;
    let mut chunk = vec![0_u8; 4 * 1024];
    while position > 0 {
        let start = position.saturating_sub(chunk.len() as u64);
        file.seek(SeekFrom::Start(start))?;
        let amount = file.read(&mut chunk[..(position - start) as usize])?;
        if let Some(offset) = chunk[..amount].iter().rposition(|byte| *byte == b'\n') {
            let end = start + offset as u64 + 1;
            if end < length {
                file.set_len(end)?;
                file.sync_data()?;
            }
            return Ok(());
        }
        position = start;
    }
    file.set_len(0)?;
    file.sync_data()
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match create_private_directory(path) {
                Ok(()) => fs::symlink_metadata(path)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    fs::symlink_metadata(path)?
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::other("unsafe directory"));
    }
    set_private_directory_permissions(path, &metadata)
}

fn safe_journal_set(journal: &Path) -> io::Result<()> {
    safe_journal_path(journal)?;
    for index in 1..=MAX_ARCHIVES {
        safe_journal_path(&archive_path(journal, index))?;
    }
    Ok(())
}

fn safe_journal_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(io::Error::other("unsafe journal path"));
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn rotate(journal: &Path) -> io::Result<()> {
    // Validate every path before changing any of them. A symlink is treated as
    // an unsafe installation rather than followed or removed.
    safe_journal_set(journal)?;
    let oldest = archive_path(journal, MAX_ARCHIVES);
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (1..MAX_ARCHIVES).rev() {
        let source = archive_path(journal, index);
        if source.exists() {
            fs::rename(source, archive_path(journal, index + 1))?;
        }
    }
    if journal.exists() {
        fs::rename(journal, archive_path(journal, 1))?;
    }
    Ok(())
}

fn archive_path(journal: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", journal.display(), index))
}

fn path_identifier(provider: &str, session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider.as_bytes());
    hasher.update([0]);
    hasher.update(session_id.as_bytes());
    let digest = hasher.finalize();
    let mut result = String::with_capacity(64);
    for byte in digest {
        result.push_str(&format!("{byte:02x}"));
    }
    result
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

struct JournalLock {
    _file: File,
}

impl JournalLock {
    fn acquire(path: &Path) -> io::Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        add_no_follow(&mut options);
        let file = options.open(path)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("unsafe lock path"));
        }
        set_private_file_permissions(&file)?;
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                break;
            }
            #[cfg(unix)]
            {
                let result =
                    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
                if result == 0 {
                    return Ok(Self { _file: file });
                }
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EAGAIN) {
                    return Err(error);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = file;
                return Err(io::Error::other("advisory locking is unsupported"));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(LOCK_WAIT.min(remaining));
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "journal lock"))
    }
}

fn set_private_directory_permissions(path: &Path, metadata: &Metadata) -> io::Result<()> {
    let mut permissions = metadata.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o700);
    }
    fs::set_permissions(path, permissions)
}

fn set_private_file_permissions(file: &File) -> io::Result<()> {
    let mut permissions = file.metadata()?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o600);
    }
    file.set_permissions(permissions)
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}

#[cfg(unix)]
fn add_no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .mode(0o600);
}

#[cfg(not(unix))]
fn add_no_follow(_options: &mut OpenOptions) {}

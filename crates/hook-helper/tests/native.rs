use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "agent-status-tiles-hook-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn invoke(data_dir: &Path, payload: &str) {
    invoke_provider(data_dir, "claude", payload);
}

fn invoke_provider(data_dir: &Path, provider: &str, payload: &str) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hook-helper"))
        .args(["--provider", provider, "--data-dir"])
        .arg(data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let output = wait_bounded(child);
    assert!(output.status.success());
    assert!(
        output.stdout.is_empty(),
        "helper wrote stdout: {:?}",
        output.stdout
    );
    assert!(
        output.stderr.is_empty(),
        "helper wrote stderr: {:?}",
        output.stderr
    );
}

fn wait_bounded(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait().unwrap() {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("hook helper subprocess exceeded test deadline");
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    }
    child.wait_with_output().unwrap()
}

fn spawn(data_dir: &Path, payload: &str) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hook-helper"))
        .args(["--provider", "claude", "--data-dir"])
        .arg(data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    child
}

fn journal_files(data_dir: &Path) -> Vec<PathBuf> {
    journal_files_for(data_dir, "claude")
}

fn journal_files_for(data_dir: &Path, provider: &str) -> Vec<PathBuf> {
    let provider_dir = data_dir.join("journals").join(provider);
    fs::read_dir(provider_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().contains(".jsonl"))
        })
        .collect()
}

#[test]
fn native_helper_reduces_fixture_and_is_silent_on_malformed_input() {
    let data_dir = temp_dir("reduction");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"Stop","session_id":"s-1","turn_id":"t-1","prompt_id":"p-1","tool_use_id":"tool-1","tool_name":"AskUserQuestion","timestamp":1700000000000,"cwd":"/tmp/Project","project_name":"must-not-read","surface":"terminal","application":"Ghostty","stop_hook_active":true,"prompt":"must-not-persist","tool_input":{"secret":"must-not-persist"}}"#,
    );
    invoke(&data_dir, "not-json");
    let not_directory = data_dir.join("not-a-directory");
    fs::write(&not_directory, b"").unwrap();
    invoke(
        &not_directory,
        r#"{"hook_event_name":"SessionEnd","session_id":"s-1"}"#,
    );
    let files = journal_files(&data_dir);
    assert_eq!(files.len(), 1);
    let line = fs::read_to_string(&files[0]).unwrap();
    let value: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["event_name"], "Stop");
    assert_eq!(value["tool_name"], "AskUserQuestion");
    assert_eq!(value["prompt_id"], "p-1");
    assert_eq!(value["stop_hook_active"], true);
    assert_eq!(value["project_name"], "Project");
    assert!(value["project_id"].as_str().unwrap().len() == 64);
    assert!(value.get("project_cwd").is_none());
    assert!(value.get("surface").is_none());
    assert!(value.get("application").is_none());
    assert!(value.get("prompt").is_none());
    assert!(value.get("tool_input").is_none());
    assert!(line.len() <= hook_helper::MAX_RECORD_BYTES);
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn native_helper_rejects_oversized_or_missing_fields_and_keeps_stop_failure_raw() {
    let data_dir = temp_dir("invalid");
    invoke(&data_dir, r#"{"hook_event_name":"Stop"}"#);
    let oversized_id = "x".repeat(hook_helper::MAX_INPUT_BYTES);
    let oversized = format!(r#"{{"hook_event_name":"Stop","session_id":"{oversized_id}"}}"#);
    invoke(&data_dir, &oversized);
    assert!(!data_dir.join("journals").exists());

    invoke(
        &data_dir,
        r#"{"hook_event_name":"StopFailure","session_id":"failure","error":"rate_limit","error_details":"secret","last_assistant_message":"secret"}"#,
    );
    let file = journal_files(&data_dir).pop().unwrap();
    let record: Value = serde_json::from_str(fs::read_to_string(file).unwrap().trim()).unwrap();
    assert_eq!(record["event_name"], "StopFailure");
    assert!(record.get("error").is_none());
    assert!(record.get("error_details").is_none());
    assert!(record.get("last_assistant_message").is_none());
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn native_helper_keeps_notification_and_elicitation_correlations_allowlisted() {
    let data_dir = temp_dir("correlations");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"Notification","session_id":"notification","notification_type":"permission_prompt","text":"discard"}"#,
    );
    invoke(
        &data_dir,
        r#"{"hook_event_name":"Elicitation","session_id":"elicitation","elicitation_id":"e-1","content":"discard"}"#,
    );
    let mut records = Vec::new();
    for file in journal_files(&data_dir) {
        for line in fs::read_to_string(file).unwrap().lines() {
            records.push(serde_json::from_str::<Value>(line).unwrap());
        }
    }
    assert_eq!(records.len(), 2);
    assert!(records.iter().any(|record| {
        record["notification_type"] == "permission_prompt" && record.get("text").is_none()
    }));
    assert!(records
        .iter()
        .any(|record| { record["elicitation_id"] == "e-1" && record.get("content").is_none() }));
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn native_helper_maps_the_codex_tool_call_id_field() {
    let data_dir = temp_dir("codex-tool");
    invoke_provider(
        &data_dir,
        "codex",
        r#"{"hook_event_name":"PreToolUse","session_id":"codex","turn_id":"turn","tool_call_id":"call-1","tool_name":"request_user_input"}"#,
    );
    let file = journal_files_for(&data_dir, "codex")
        .into_iter()
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".jsonl")
        })
        .unwrap();
    let record: Value = serde_json::from_str(fs::read_to_string(file).unwrap().trim()).unwrap();
    assert_eq!(record["provider"], "codex");
    assert_eq!(record["tool_call_id"], "call-1");
    assert_eq!(record["tool_name"], "request_user_input");
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn concurrent_native_callbacks_are_complete_and_replayable() {
    let data_dir = temp_dir("concurrency");
    let mut children = Vec::new();
    for index in 0..32 {
        let payload = format!(
            "{{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"shared\",\"turn_id\":\"turn-{index}\"}}"
        );
        children.push(spawn(&data_dir, &payload));
    }
    for child in children {
        let output = wait_bounded(child);
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }

    let mut turns = HashSet::new();
    for file in journal_files(&data_dir) {
        let contents = fs::read_to_string(file).unwrap();
        for line in contents.lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            turns.insert(value["turn_id"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(turns.len(), 32);
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn native_rotation_keeps_bounded_replay_and_malformed_callbacks_are_noop() {
    let data_dir = temp_dir("rotation");
    let large = "x".repeat(240);
    for index in 0..220 {
        let payload = format!(
            "{{\"hook_event_name\":\"Stop\",\"session_id\":\"{large}\",\"turn_id\":\"turn-{large}-{index}\",\"prompt_id\":\"{large}\",\"tool_use_id\":\"{large}\",\"cwd\":\"/tmp/{}\"}}",
            "x".repeat(900),
        );
        invoke(&data_dir, &payload);
    }
    let files = journal_files(&data_dir);
    assert!(!files.is_empty());
    assert!(files.len() <= hook_helper::MAX_ARCHIVES + 1);
    let line_count: usize = files
        .iter()
        .map(|file| {
            let metadata = fs::metadata(file).unwrap();
            assert!(metadata.len() <= hook_helper::MAX_JOURNAL_BYTES);
            fs::read_to_string(file).unwrap().lines().count()
        })
        .sum();
    assert_eq!(
        line_count, 220,
        "all records fit within the retained archives"
    );

    let before: Vec<_> = journal_files(&data_dir)
        .into_iter()
        .map(|path| (path.clone(), fs::read(path).unwrap()))
        .collect();
    invoke(&data_dir, "not-json");
    for (path, bytes) in before {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    fs::remove_dir_all(data_dir).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinked_journal_is_not_followed() {
    use std::os::unix::fs::symlink;

    let data_dir = temp_dir("symlink");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionStart","session_id":"symlinked"}"#,
    );
    let journal = journal_files(&data_dir).pop().unwrap();
    let external_dir = temp_dir("external");
    let external = external_dir.join("outside.jsonl");
    fs::write(&external, b"untouched\n").unwrap();
    fs::remove_file(&journal).unwrap();
    symlink(&external, &journal).unwrap();
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionEnd","session_id":"symlinked"}"#,
    );
    assert_eq!(fs::read_to_string(external).unwrap(), "untouched\n");
    fs::remove_dir_all(data_dir).unwrap();
    fs::remove_dir_all(external_dir).unwrap();
}

#[test]
fn native_helper_repairs_an_unterminated_tail_before_replay() {
    let data_dir = temp_dir("partial-tail");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionStart","session_id":"partial"}"#,
    );
    let journal = journal_files(&data_dir).pop().unwrap();
    let mut file = fs::OpenOptions::new().append(true).open(&journal).unwrap();
    file.write_all(br#"{"hook_event_name":"Stop","session_id":"partial""#)
        .unwrap();
    drop(file);
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionEnd","session_id":"partial"}"#,
    );
    let contents = fs::read_to_string(journal).unwrap();
    let lines: Vec<_> = contents.lines().collect();
    assert_eq!(lines.len(), 2);
    for line in lines {
        let _: Value = serde_json::from_str(line).unwrap();
    }
    fs::remove_dir_all(data_dir).unwrap();
}

#[cfg(unix)]
#[test]
fn native_helper_does_not_open_or_mutate_a_fifo_journal() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::FileTypeExt;

    let data_dir = temp_dir("fifo");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionStart","session_id":"fifo"}"#,
    );
    let journal = journal_files(&data_dir).pop().unwrap();
    fs::remove_file(&journal).unwrap();
    let path = CString::new(journal.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionEnd","session_id":"fifo"}"#,
    );
    assert!(fs::symlink_metadata(&journal)
        .unwrap()
        .file_type()
        .is_fifo());
    fs::remove_file(journal).unwrap();
    fs::remove_dir_all(data_dir).unwrap();
}

#[cfg(unix)]
#[test]
fn native_helper_rejects_a_fifo_lock_without_blocking() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::FileTypeExt;
    use std::time::Instant;

    let data_dir = temp_dir("fifo-lock");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionStart","session_id":"fifo-lock"}"#,
    );
    let journal = journal_files(&data_dir).pop().unwrap();
    let lock = journal.parent().unwrap().join(format!(
        "{}.lock",
        journal.file_stem().unwrap().to_string_lossy()
    ));
    fs::remove_file(&lock).unwrap();
    let path = CString::new(lock.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let started = Instant::now();
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionEnd","session_id":"fifo-lock"}"#,
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(fs::symlink_metadata(&lock).unwrap().file_type().is_fifo());
    fs::remove_file(lock).unwrap();
    fs::remove_dir_all(data_dir).unwrap();
}

#[cfg(unix)]
#[test]
fn native_helper_fails_open_after_a_bounded_held_lock_wait() {
    use std::os::fd::AsRawFd;
    use std::time::Instant;

    let data_dir = temp_dir("lock-timeout");
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionStart","session_id":"lock-held"}"#,
    );
    let journal = journal_files(&data_dir).pop().unwrap();
    let lock = journal.parent().unwrap().join(format!(
        "{}.lock",
        journal.file_stem().unwrap().to_string_lossy()
    ));
    let lock_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock)
        .unwrap();
    assert_eq!(
        unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX) },
        0
    );
    let before = fs::read(&journal).unwrap();
    let started = Instant::now();
    invoke(
        &data_dir,
        r#"{"hook_event_name":"SessionEnd","session_id":"lock-held"}"#,
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(fs::read(journal).unwrap(), before);
    assert_eq!(
        unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_UN) },
        0
    );
    fs::remove_dir_all(data_dir).unwrap();
}

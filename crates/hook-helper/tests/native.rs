use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

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
    let output = child.wait_with_output().unwrap();
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
    let provider_dir = data_dir.join("journals/claude");
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
        r#"{"hook_event_name":"Stop","session_id":"s-1","turn_id":"t-1","prompt_id":"p-1","tool_use_id":"tool-1","tool_name":"AskUserQuestion","timestamp":1700000000000,"cwd":"/tmp/project","project_name":"Project","surface":"terminal","application":"Ghostty","stop_hook_active":true,"prompt":"must-not-persist","tool_input":{"secret":"must-not-persist"}}"#,
    );
    invoke(&data_dir, "not-json");
    let not_directory = data_dir.join("not-a-directory");
    fs::write(&not_directory, b"").unwrap();
    invoke(
        &not_directory,
        r#"{"event_name":"SessionEnd","session_id":"s-1"}"#,
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
fn native_helper_keeps_notification_and_elicitation_correlations_allowlisted() {
    let data_dir = temp_dir("correlations");
    invoke(
        &data_dir,
        r#"{"event_name":"Notification","session_id":"notification","notification_type":"permission_prompt","text":"discard"}"#,
    );
    invoke(
        &data_dir,
        r#"{"event_name":"Elicitation","session_id":"elicitation","elicitation_id":"e-1","content":"discard"}"#,
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
fn concurrent_native_callbacks_are_complete_and_replayable() {
    let data_dir = temp_dir("concurrency");
    let mut children = Vec::new();
    for index in 0..32 {
        let payload = format!(
            "{{\"event_name\":\"UserPromptSubmit\",\"session_id\":\"shared\",\"turn_id\":\"turn-{index}\"}}"
        );
        children.push(spawn(&data_dir, &payload));
    }
    for child in children {
        let output = child.wait_with_output().unwrap();
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
            "{{\"event_name\":\"TaskCompleted\",\"session_id\":\"{large}\",\"turn_id\":\"turn-{large}-{index}\",\"prompt_id\":\"{large}\",\"tool_call_id\":\"{large}\",\"cwd\":\"/tmp/{}\",\"project_name\":\"{large}\"}}",
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
        r#"{"event_name":"SessionStart","session_id":"symlinked"}"#,
    );
    let journal = journal_files(&data_dir).pop().unwrap();
    let external_dir = temp_dir("external");
    let external = external_dir.join("outside.jsonl");
    fs::write(&external, b"untouched\n").unwrap();
    fs::remove_file(&journal).unwrap();
    symlink(&external, &journal).unwrap();
    invoke(
        &data_dir,
        r#"{"event_name":"SessionEnd","session_id":"symlinked"}"#,
    );
    assert_eq!(fs::read_to_string(external).unwrap(), "untouched\n");
    fs::remove_dir_all(data_dir).unwrap();
    fs::remove_dir_all(external_dir).unwrap();
}

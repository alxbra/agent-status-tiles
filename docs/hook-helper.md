# Hook helper contract

`hook-helper` is a small native executable bundled with Agent Status Tiles. It
has no Node.js, Python, or user-installed Rust runtime dependency at runtime.
The app invokes a stable absolute executable path for each hook callback:

```text
hook-helper --provider codex|claude --data-dir /absolute/private/app-data
```

The provider and data directory are explicit arguments. Relative data paths and
unknown arguments are rejected as a silent successful no-op.

## Input and privacy

The helper reads one JSON object from stdin, up to 64 KiB. It accepts the
allowlisted lifecycle names used by Claude hooks and the local Codex observer:
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`,
`StopFailure`, `Elicitation`, and `ElicitationResult`.

For accepted events it retains only these bounded fields:

- `provider`, `event_name`, `session_id`, optional `turn_id`, optional
  `prompt_id`, optional `elicitation_id`, and optional `tool_call_id`. The
  output `tool_call_id` is sourced from Claude's canonical `tool_use_id` or
  Codex's canonical `tool_call_id` according to the explicit provider argument;
- `timestamp` (canonical receipt time in Unix milliseconds);
- `project_name` and a one-way SHA-256 `project_id` derived from a normalized
  absolute cwd. The raw cwd is never journaled;
- validated `notification_type` values (`permission_prompt`, `idle_prompt`,
  `auth_success`, `elicitation_dialog`, `elicitation_complete`, or
  `elicitation_response`) for `Notification` events; and
- `stop_hook_active` when supplied as a boolean, so a Stop callback is not
  mistaken for definitive completion while another hook continues the turn.

`tool_name` is retained only when it is exactly `AskUserQuestion` or
`request_user_input`. Prompts, answers, text, command/tool input or output,
transcripts, credentials, and all other input keys are discarded. Titles are
resolved by the app from the retained project metadata; the helper never
derives a title from content. Unknown events, malformed JSON, oversized input,
missing session IDs, and invalid fields are ignored.

## Journal and replay contract

Each session receives a JSON Lines journal at:

```text
<data-dir>/journals/<provider>/<fixed-hash>.jsonl
```

The fixed-width hash is derived from provider plus native session ID. It is not
reversible and prevents IDs from becoming path components. The JSON record
schema is version `1` and has the following shape (optional fields are omitted):

```json
{
  "schema_version": 1,
  "provider": "claude",
  "event_name": "Stop",
  "session_id": "native-id",
  "turn_id": "turn-id",
  "prompt_id": "prompt-id",
  "tool_call_id": "tool-id",
  "tool_name": "AskUserQuestion",
  "timestamp": 1700000000000,
  "project_name": "project",
  "project_id": "sha256-of-normalized-project-cwd",
  "stop_hook_active": false
}
```

`elicitation_id` appears only on `Elicitation` and `ElicitationResult`
records. `notification_type` appears only on `Notification` records.

Every record, including its newline, is at most 4 KiB. The active journal is
limited to 256 KiB. Before an append that would exceed the limit, the helper
rotates `<hash>.jsonl` to `.1`, shifts `.1` through `.2` to `.3`, and removes
the oldest `.3`; at most three archives plus the active file are retained.
Rotation and append happen while a per-session advisory lock is held, so
concurrent hook processes produce complete, replayable lines. The lock file is
kept as a private coordination inode and the operating system releases its
lock if a helper crashes; no stale-lock deletion race is possible. The app can
replay archives oldest-to-newest and then tail the active file; records have no
helper-side state mapping, so the app owns lifecycle reduction, deduplication,
and cursor persistence. `Stop` and `StopFailure` are raw candidates only;
`stop_hook_active` is preserved as metadata and the app must account for
parallel hooks before declaring a turn complete. A contended lock is retried
for at most 500 ms before the helper fails open with a silent success.

Journal directories and files are private (`0700` directories and `0600`
files on macOS). Existing symlinks or non-regular journal/lock paths cause a
successful no-op; the helper never follows them. Callbacks continue to journal
while the companion is closed, allowing replay after restart. Owning-app and
terminal identity are controlled enrichment supplied by the app/adapter; the
helper does not trust arbitrary input fields as navigation targets.

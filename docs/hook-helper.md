# Hook helper contract

`hook-helper` is a small native executable bundled with Agent Status Tiles. It
has no Node.js, Python, or user-installed Rust runtime dependency at runtime.
The app invokes a stable absolute executable path for each hook callback:

```text
hook-helper --provider codex|claude --data-dir /absolute/private/app-data
```

The provider and data directory are explicit arguments. Relative data paths and
unknown arguments are rejected as a silent successful no-op.

## Developer packaging

The packaged application carries the helper outside its ASAR archive as an
executable resource. `pnpm run pack` builds both supported macOS targets and
places them at these stable resource paths:

```text
Agent Status Tiles.app/Contents/Resources/hook-helper/arm64/hook-helper
Agent Status Tiles.app/Contents/Resources/hook-helper/x64/hook-helper
```

The future app integration selects the directory matching Electron's
`process.arch` and invokes the helper by absolute path. Packaging does not
install hooks or choose a user-data directory; those are separate integration
and installer responsibilities. To build one target while developing, use
`pnpm run build:hook-helper -- --arch arm64` (or `x64`). If Cargo is not on
`PATH`, pass its executable explicitly with `--cargo PATH` or set
`HOOK_HELPER_CARGO`. The selected Rust toolchain must provide the corresponding
`aarch64-apple-darwin` or `x86_64-apple-darwin` target; missing toolchains,
targets, build output, and architecture mismatches fail the build clearly.

The helper is copied by electron-builder's `extraResources` configuration,
which places it under macOS `Contents/Resources` rather than inside ASAR. The
macOS `beforePack` hook validates the helper matching the selected Electron
architecture, so direct `electron-builder --dir` packaging also fails clearly
when that resource is missing, non-executable, truncated, or the wrong arch.
The developer package is unsigned: these checks do not establish code-signing,
notarization, or Gatekeeper acceptance. See electron-builder's
[application contents documentation](https://www.electron.build/docs/contents/)
for the `extraResources` placement contract.

## Installation into Claude Code settings

`src/main/providers/claude/hook-installer.ts` owns the entries the app writes
into the user's Claude Code settings file, `~/.claude/settings.json` by
default (Claude Desktop and the terminal CLI share it). The helper path comes
from `src/main/providers/claude/helper-path.ts`: the packaged resource under
`Contents/Resources/hook-helper/<arch>/hook-helper`, or
`build/hook-helper/<arch>/hook-helper` in development, and only when it is a
regular, owner-executable file rather than a symlink. A quarantined app that
macOS runs from a throwaway App Translocation path is refused
(`helper-translocated`), because that path would not survive the next launch.

The installer writes exactly one matcher-less group per event in the helper's
allowlist, each holding one command hook:

```json
{ "type": "command", "command": "'<helper>' --provider claude --data-dir '<app-data>'", "timeout": 5, "async": true }
```

Both paths are single-quoted for the shell, and the fixed argument order is the
ownership marker: an entry is owned only when it parses back to an absolute
`hook-helper` path plus `--provider claude --data-dir` and an absolute data
directory. Because ownership is decided by that shape alone, a development
build and a packaged build installing into the same settings file replace each
other's entry. Every other key, event, matcher group, and hook in the file is
kept in place and in order, including the position of the `hooks` key.
Installing over a stale owned entry replaces it; removing deletes only owned
entries and drops the groups, events, and `hooks` object that become empty. A
file whose planned content equals its current content is not rewritten, which
also covers a complete install the user has silenced with `disableAllHooks`.

The file is re-serialised as two-space JSON with a trailing newline, the same
form Claude Code writes. Writes go through a symlinked settings file rather
than replacing the link, keep the file's exact mode regardless of the umask,
land through a temporary file and rename, and remove that temporary file on
any failure. Claude Desktop and the CLI write the same file, so the version the
plan was computed from is re-checked immediately before the rename and a
changed file aborts the write untouched (`settings-changed`); the caller
simply retries. A file that is not valid JSON, not a JSON object, larger than
1 MiB, or whose `hooks` section has an unexpected shape is never rewritten,
and a dangling symlink or a non-file at the path is reported rather than
replaced. Typed errors name the reason: `settings-unreadable`,
`settings-not-json`, `settings-not-object`, `settings-oversized`,
`hooks-unsupported`, `settings-changed`, or `settings-unwritable`.

Verification reports `installed` (every event carries exactly one owned entry
with the exact written shape in a matcher-less group), `missing`, `stale` (an
owned entry is absent, duplicated, matcher-scoped, or differs in any field),
`disabled` when `disableAllHooks` is set in the same file, or `unreadable`
with one of the codes above. Connecting the Claude row and surfacing these
states in Settings belong to later slices.

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
  `elicitation_response`) for `Notification` events;
- `stop_hook_active` when supplied as a boolean, so a Stop callback is not
  mistaken for definitive completion while another hook continues the turn;
- `host`, the launching application, taken from the process environment's
  `__CFBundleIdentifier` (macOS sets it for GUI-launched processes and hook
  processes inherit it) and mapped, after trimming surrounding whitespace, to
  exactly `claude-desktop`, `terminal`, `iterm2`, `ghostty`, or `warp`. Any
  other value, such as an IDE terminal or an SSH session, produces no field;
- `entrypoint`, Claude Code's `CLAUDE_CODE_ENTRYPOINT` when, after trimming,
  it is exactly `claude-desktop` or `cli`. Only `--provider claude` records
  carry it: a Codex hook launched from inside a Claude session inherits the
  variable but must not record it. Other entrypoints produce no field;
- `is_subagent: true` when the hook input carries a non-empty `agent_id`
  string. Subagent hooks reuse the parent session ID; the agent ID itself is
  discarded;
- `session_source` on `SessionStart` (`startup`, `resume`, `clear`, `compact`,
  or `fork`) and `end_reason` on `SessionEnd` (`clear`, `resume`, `logout`,
  `prompt_input_exit`, or `other`).

No other environment variable is read, and the raw variable values are never
journaled. The two host variables are observed behaviour rather than a
documented hook contract, which is why unrecognised values are dropped rather
than recorded.

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
  "stop_hook_active": false,
  "host": "claude-desktop",
  "entrypoint": "claude-desktop",
  "is_subagent": true
}
```

Version 1 evolves by adding optional fields; the version bumps only when a
required field or a field's meaning changes, so a reader always tolerates
records older than itself.

`elicitation_id` appears only on `Elicitation` and `ElicitationResult`
records. `notification_type` appears only on `Notification` records.
`session_source` appears only on `SessionStart` and `end_reason` only on
`SessionEnd`; `host`, `entrypoint`, and `is_subagent` appear on any record
when their allowlisted value is present.

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
and cursor persistence. `Stop` is a raw completion candidate;
`StopFailure` is a failure signal and never implies success. `stop_hook_active`
is preserved as metadata and the app must account for parallel hooks before
declaring a turn complete. A contended lock is retried
for at most 500 ms before the helper fails open with a silent success.

Journal directories and files are private (`0700` directories and `0600`
files on macOS). Existing symlinks or non-regular journal/lock paths cause a
successful no-op; the helper never follows them. Callbacks continue to journal
while the companion is closed, allowing replay after restart. Owning-app and
terminal identity come only from the allowlisted environment mapping above,
never from hook input fields; the helper does not trust arbitrary input fields
as navigation targets.

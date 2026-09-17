# Claude monitor contract

`src/main/providers/claude/` turns the helper's private journals into the
shared session model. It has no knowledge of Claude's own files: it never
reads `~/.claude`, transcripts, or the settings file, and no path leaves the
module. One `ClaudeSurfaceMonitor` runs per surface (`claude:desktop`,
`claude:cli`) behind the shared `Claude Code` Settings row.

## Discovery

`ClaudeJournalDiscovery` lists the app's own `<userData>/journals/claude`
directory: at most 512 entries are considered, only regular files named
`<64 hex>.jsonl` (the active journal of one session), sorted newest first by
modification time, and at most 64 are inspected per pass. Inspecting a journal
reads only its first and last complete records (8 KiB at each end). The first
record must carry a `session_id` whose hash is the file name, and the last
record must belong to the same session; the file is otherwise ignored. A
journal that has not changed size or modification time is not re-read.

Each inspected journal yields display-safe facts only: the session ID, the
project folder name from the newest record, the surface, the recognised
launching application (`host`), whether the newest record is `SessionEnd`,
the modification time, and the active file size. The surface is `desktop`
when the newest identified record carries `host: claude-desktop` or
`entrypoint: claude-desktop`, and `cli` otherwise, including an unrecognised
host such as an IDE terminal. A session that moves surfaces (`/desktop`,
`/resume`) changes cohort when its newest record does; the coordinator's owner
reconciliation keeps one tile on the most recently confirmed surface.

Each monitor reports the newest `RECENT_THREAD_DISCOVERY_WINDOW` journals of
its own surface whose newest record is not `SessionEnd`, following the
[PR #33 cohort contract](../MVP_PLAN.md): the page is complete, an unreported
session is dropped by the coordinator whatever its status, and it reappears
when its journal grows again. An ended session therefore leaves the dock on
the next 2 s discovery; a session killed without `SessionEnd` keeps its last
state until it ages out of the window, because silence is never interpreted.

Sources use the journal hash as their ID and cursor key, the project folder
name as the title (a short session ID when none was recorded), the journal's
modification time as `updatedAt`, and the active file size as the baseline
cutoff. Titles never come from prompt content.

## Replay

Reads pass the first `MAX_RECENT_THREAD_LIMIT` sources to `HookJournalReader`
as explicit targets and report the rest as metadata-only, exactly as the Codex
monitor does. Reader diagnostics that mean a journal could not be read safely
(`unsafe-source`, `source-not-regular`, `source-oversized`,
`source-read-failed`, `source-truncated`, `source-unstable`, `cursor-limit`)
mark that source unavailable; malformed or oversized records, retention gaps,
and truncated cursors only mark coverage incomplete. When the reader returns
no continuation it has consumed every retained byte of every target, so all
read sources are reported exhausted and the read is complete. Frozen cutoffs
are not applied to journals: a record that arrives during a baseline pass is
replayed as historical, which can at worst hide one completion that landed in
that window, never surface a stale one.

## Normalization

`normalizeClaudeEvents` maps journal records onto the lifecycle events of the
shared reducer, per session and in journal order. Claude hooks carry no turn
identifier, so a turn is keyed by the receipt time of the `UserPromptSubmit`
that started it and every later record of the session attaches to the newest
turn; the persisted record's active turn and open requests seed the state at
the start of each read.

| Journal record | Lifecycle event |
| --- | --- |
| `UserPromptSubmit` | `turn-started` |
| `PreToolUse` for `AskUserQuestion` / `request_user_input`, `PermissionRequest`, `Elicitation`, `Notification` `permission_prompt` / `elicitation_dialog` | `input-requested` (call ID, elicitation ID, or a timestamped placeholder) |
| `PostToolUse` | `input-resolved` for its own call ID and any notification placeholder, then `activity`; without a matching open request it resolves everything open |
| `ElicitationResult`, `Notification` `elicitation_complete` / `elicitation_response` | `input-resolved` |
| other `PreToolUse`, `PostToolUseFailure` | resolves everything open, then `activity` |
| `Stop` with neither `stop_hook_active` nor `is_subagent` | `turn-completed` with a deterministic completion ID |
| `Stop` from a subagent or while another stop hook continues the turn, or before any turn | `activity` |
| `StopFailure` | `turn-failed` |
| `SessionStart`, `SessionEnd`, other notifications | nothing (`SessionEnd` acts through discovery) |

A subagent stopping never completes the parent, and an ordinary tool failure
never reddens a session. `Stop` and `StopFailure` close the tracked turn so a
late record after them is plain activity the reducer ignores.

## Not in this slice

Connecting the `Claude Code` row (hook installation, health from the hook
verification state, Repair), navigation, and the live Desktop and terminal
validation matrix belong to later slices; until then the Claude partitions are
enabled only by tests.

# Claude monitor contract

`src/main/providers/claude/` turns the helper's private journals into the
shared session model. It has no knowledge of Claude's own files: it never
reads `~/.claude`, transcripts, or the settings file, and no path leaves the
module. One `ClaudeSurfaceMonitor` runs per surface (`claude:desktop`,
`claude:cli`) behind the shared `Claude Code` Settings row.

## Discovery

One `ClaudeJournalDiscovery` instance, shared by both surface monitors, lists
the app's own `<userData>/journals/claude` directory: regular files named
`<64 hex>.jsonl` (the active journal of one session) are stat'ed, at most
4,096 of them, sorted newest first by modification time, and the newest 64
are inspected per pass. Inspecting a journal reads only its first and last
complete records (8 KiB at each end, never following a symlink). The first
record must carry a `session_id` whose hash is the file name, and the last
record must belong to the same session; the file is otherwise ignored. A
journal that has not changed size or modification time is not re-read, and
overlapping listings from the two monitors share one pass. While the helper
rotates a journal (the active file is briefly absent or empty next to a `.1`
archive) the previous summary is kept for at most two passes, so a rotation
never looks like an ended session while a deleted journal with a stale archive
is forgotten. A directory holding more journals than can be stat'ed reports
incomplete coverage. Nothing deletes old journals yet; journal garbage
collection for ended sessions, removing every suffix, is a required follow-up
before release.

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
the next 2 s discovery, including one that ended unread; unlike a Codex thread
that aged off the page, an ended Claude session only returns if it is resumed
into the same session ID. A session killed without `SessionEnd` keeps its last
state until it ages out of the window, because silence is never interpreted.

Sources use the journal hash as their ID and cursor key, the project folder
name as the title (a short session ID when none was recorded), the journal's
modification time as `updatedAt`, and the active file size as the baseline
cutoff. Titles never come from prompt content.

## Replay

Reads pass the first `MAX_RECENT_THREAD_LIMIT` sources to `HookJournalReader`
as explicit targets and report the rest as metadata-only, exactly as the Codex
monitor does. A record can expand into two lifecycle events and seeding a
read can resolve every open request of every target, so each read asks the
reader for at most `MAX_CLAUDE_RECORDS_PER_READ` records (1,408) and continues
across passes; one read therefore never exceeds the coordinator's per-read
event cap. Reader diagnostics that mean a journal could not be read safely
(`unsafe-source`, `source-not-regular`, `source-oversized`,
`source-read-failed`, `source-truncated`, `source-unstable`) mark that source
unavailable; malformed or oversized records, retention gaps, and truncated
cursors mark coverage incomplete; `read-limit` is an ordinary budget stop
followed by a continuation and marks nothing. Without a continuation the
reader has consumed every complete record of every readable target, so all
read sources are reported exhausted and the read is complete. Frozen cutoffs
are not applied to journals: discovery and the first read run in the same
pass, and a record landing between them during a baseline is replayed as
historical, which can hide a completion from that moment but never surfaces
a stale one.

A baseline exists only to land history idle and place the cursor, so during a
baseline pass the monitor keeps the turn events that decide a session's final
state (`turn-started`, `turn-completed`, `turn-failed`) and drops per-tool
progress and waits. A first replay of ten sessions with full archives then
stays far below the coordinator's per-replay event bound. The one visible
consequence: a wait that is already open when the surface connects shows as
working until its next hook record.

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

Prompt notifications are supplementary: they open a wait only when no request
from a permission, question, or elicitation hook is already open. Persistence
keeps at most 128 requests per session, resolved ones included, so after 128
requests in one turn further prompts count as progress rather than waits and
the surface stays up. A subagent stopping never completes the parent, and an
ordinary tool failure never reddens a session. `Stop` and `StopFailure` close the tracked turn so a
late record after them is plain activity the reducer ignores. In a parallel
tool batch, another tool finishing while one permission prompt is still open
resolves that prompt too: confirmed activity means the user acted, and a
denied permission would otherwise leave the tile waiting forever; the prompt
notification re-opens the wait if the dialog is still up.

## Connecting

The `Claude Code` Settings row bundles both surfaces. Connect confirms the
change it is about to make, installs the owned hooks into the shared Claude
settings file first (see the installation section of `docs/hook-helper.md`)
and only then enables the two partitions; a failed install enables nothing,
and a partition failure after a successful install removes the hooks again so
a disconnected row never leaves hooks behind. Disconnect disables both
partitions and then removes only the owned hooks, even when a partition
failed to disable, and its confirmation says exactly that. Repair reinstalls
the hooks and restarts the enabled surfaces through the coordinator's
connect, which re-baselines them so nothing historical turns unread. A
Connect or Repair that fails for a known reason (the helper cannot be found
or used, the settings file cannot be read or updated, or it changed
underneath the write) leaves the row disconnected and shows that reason as
one sentence until the next action.

Each monitor verifies readiness when it starts: the bundled helper must
resolve and the hooks must be installed with the current helper path and not
silenced by `disableAllHooks`. A failed check keeps the surface in `error`
health with the coordinator's retry and records one issue (`helper-missing`,
`helper-translocated`, `helper-unusable`, `hooks-missing`, `hooks-disabled`,
or `settings-unreadable`), each shown in Settings as one actionable sentence.
The helper is resolved on every check and install, so a helper built or moved
after launch is noticed without a restart, and one settings-file read serves
both surfaces when they start together. A test
run supplies the helper path and configuration directory explicitly; without
them the monitors run seeded journals with no readiness check and never touch
a settings file. In development the helper must exist under
`build/hook-helper/<arch>/`, which requires a Rust toolchain.

## Not in this slice

Navigation and the live Desktop and terminal validation matrix belong to
later slices. Claude Code reloads its settings file while running, so a
session started before Connect should pick the hooks up without a restart;
the live matrix confirms this before the restart hint from the plan is
considered.

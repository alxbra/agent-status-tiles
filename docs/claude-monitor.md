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
incomplete coverage; the collection below keeps a long-lived install under
that bound as long as its sessions end with `SessionEnd`.

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

## Collection

One `ClaudeJournalCollector`, shared by both surface monitors, removes the
journals of sessions that are over. Each monitor asks it to sweep at the end
of every discovery pass; a sweep runs at most every five minutes
(`JOURNAL_SWEEP_INTERVAL_MS`), overlapping requests share one sweep, and a
sweep that fails never fails the pass. A sweep lists the same directory,
`lstat`s at most 4,096 active journals (a larger directory is walked in
sorted windows that continue where the previous sweep stopped, so every
journal is reached), and considers only regular files whose modification time
is more than seven days (`JOURNAL_RETENTION_MS`) old, oldest first. Whether
such a journal ended is decided the way discovery decides it: the file is
verified (first record hashes to the name, last record belongs to the same
session) and its newest record must be `SessionEnd`. A journal that was
killed without `SessionEnd`, that is empty beside an archive (a rotation that
never completed), or that cannot be verified as this app's is never removed.
At most 64 journals are read per sweep (`MAX_SWEEP_PROBES`); the verdict for
an unchanged file is remembered, so a backlog of live-looking old journals is
read once and then skipped, while a file that could not be read at all (an
I/O error rather than a failed verification) gets no verdict and is read
again next sweep. At most 64 removals are attempted per sweep
(`MAX_SWEEP_REMOVALS`); a journal judged on an earlier sweep does not count
against the read budget, and a set that was refused is not attempted again
until its active file changes, so a few unsafe sets can never exhaust the
removal budget.

Removing a journal removes every suffix: `.jsonl.3`, `.2`, `.1`, then the
active `.jsonl`, in that order, so an interrupted sweep leaves an ended
active file to finish next time rather than an orphaned archive nothing would
judge. Every path of the set is checked before any is touched and again at
the moment of removal, with `lstat`: a symlink, directory, or other non-file
anywhere in the set leaves the whole set alone, and a journal directory that
is itself a link is not swept, so nothing outside the app's directory is
ever followed or removed (within the same trust domain as the helper, which
also checks the directory and then acts on paths beneath it). The active file
must still have the modification time and size that were read, and that is
re-checked before each archive is removed as well as before the active file
itself; a session resumed into the same ID in between has grown its journal
and is left, archives included, for its next verdict. The app cannot take
the helper's advisory lock, so one window remains: a hook that opens the
active file for append between that final check and the `unlink` writes its
record to the removed inode, and the session's journal restarts with the next
hook's record. It needs a resume of a session that ended more than a week ago
landing within those microseconds, and the restarted journal is discovered
and replayed normally, so the consequence is one lost record of a session
that was already forgotten. The helper's `<hash>.lock` files are never
removed: the helper does not re-check the lock inode after locking, so an
app-side unlink could let two hooks hold different lock files. A lock file
is empty and is not a journal name, so it costs one directory entry and
nothing in discovery; collecting stale lock files is a follow-up that starts
in the helper.

A sweep keeps every journal the app still refers to, whatever its state: the
current cohort of either surface, every base name with a persisted cursor,
and the journal of every persisted Claude session
(`retainedClaudeJournals`). A sweep reports counts only: journals judged
(read, or empty and so unverifiable), removed, refused (a set left alone for
a symlink or non-file, or the whole sweep when the directory is not a real
directory), and failed (I/O errors, or a retained set that could not be
computed; retried on a later sweep, which is the next interval); no name,
path, or error text leaves the module.

Sessions that end without `SessionEnd` (a closed terminal, a killed process,
a crash) are never collected by this contract and accumulate until the stat
bound reports incomplete coverage; a second, longer retention for journals
that have not changed at all is a follow-up, not part of this slice.

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
Connect, Repair, or Disconnect that fails for a known reason (the helper
cannot be found or used, the settings file cannot be read or updated, or it
changed underneath the write) leaves the row as it was (disconnected after
Connect, connected after Repair, disconnected with the hooks still present
after Disconnect) and shows that reason as one sentence, naming an action the
row offers in that state, until the row's next action. Settings shows one
sentence per row: a failed action's reason takes the place of the live health
sentence until the next action.

Each monitor verifies readiness when it starts: the bundled helper must
resolve, the organization's managed settings must not block hooks from the
user settings file, and the hooks must be installed with the current helper
path and not silenced by `disableAllHooks`. A failed check keeps the surface
in `error` health with the coordinator's retry and records one issue
(`helper-missing`, `helper-translocated`, `helper-unusable`, `hooks-missing`,
`hooks-disabled`, `hooks-blocked`, or `settings-unreadable`), each shown in
Settings as one actionable sentence. The helper is resolved on every check
and install, so a helper built or moved after launch is noticed without a
restart, and one settings-file read serves both surfaces when they start
together. A test run supplies the helper path and configuration directory
explicitly and reads managed settings from a `managed` folder inside that
directory; without them the monitors run seeded journals with no readiness
check and never touch a settings file. In development the helper must exist
under `build/hook-helper/<arch>/`, which requires a Rust toolchain.

### Hooks silenced by policy

Claude Code reads `disableAllHooks` from every settings level and honours
three managed keys that keep hooks in the user settings file from running:
`disableAllHooks`, `allowManagedHooksOnly`, and `strictPluginOnlyCustomization`
(`true` or an array naming `hooks`). The readiness check reads the file-based
managed source, `/Library/Application Support/ClaudeCode/managed-settings.json`
merged with the visible `*.json` drop-ins of `managed-settings.d/` in
alphabetical order (a later single value replaces an earlier one, so a later
`false` lifts a lock; lists combine; and an `allowManagedHooksOnly` that is
present but not `false` counts as on, which is how Claude Code treats an
invalid value), and reports
`hooks-blocked` when the merged result blocks them. The sentence asks for an
administrator and promises that the connection resumes on its own, which the
coordinator's retry delivers once the policy is lifted. That read is bounded
to the same 1 MiB per file as the user settings file and at most 64
drop-ins, touches only Claude Code's own managed directory, and never
journals or displays a path.

The check never guesses. Claude Code applies only the highest-ranked managed
source by default, so when an MDM configuration profile for the
`com.anthropic.claudecode` domain exists under `/Library/Managed Preferences`
the files may not apply at all, and the check reports nothing rather than a
possible false alarm; the profile itself, server-managed settings fetched
from claude.ai, and settings an embedding host passes are not read. Whether
server-managed settings apply cannot be established locally (where Claude
Code caches them is not documented, and this module never reads `~/.claude`),
so the one residual false-alarm case is an organization that deploys hook
restrictions in a managed file while its server-managed policy, which
outranks the file, leaves hooks alone; both come from the same administrator
and the sentence still names the right person. A managed file that cannot be
read or parsed, or a drop-in directory that cannot be listed or holds more
files than the bound, reports nothing: the app cannot tell what applies
(Claude Code itself refuses to start on invalid managed JSON).

Two silencers remain undetectable and are documented rather than reported: a
`disableAllHooks` in a project's `.claude/settings.json` or
`.claude/settings.local.json` silences the hooks for that project only, and a
project `false` overrides a user-level `true`. The app never learns a
project's path (the helper journals only a one-way hash and the folder name),
so it cannot read those files, and a silenced project produces no journal at
all, not even a `SessionStart`, so there is nothing to attach a note to. Per
the plan's status rules, silence is never interpreted: a project with hooks
disabled simply never appears, and the `Claude Code` row stays healthy
because the shared hooks are in place for every other project. Settings copy
carries no note about this, in keeping with the one-sentence, actionable-only
contract of the Settings view.

## Not in this slice

Navigation and the live Desktop and terminal validation matrix belong to
later slices. Claude Code reloads its settings file while running, so a
session started before Connect should pick the hooks up without a restart;
the live matrix confirms this before the restart hint from the plan is
considered.

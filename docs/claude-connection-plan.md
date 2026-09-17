# Claude Code Desktop and CLI connection plan

## Status (2026-09-17)

| Plan PR | Delivered as | Merge |
| --- | --- | --- |
| Bundle provider rows | [#35](https://github.com/alxbra/agent-status-tiles/pull/35) | `e038791` |
| 1 hook identity | [#36](https://github.com/alxbra/agent-status-tiles/pull/36) | `6faaad2` |
| 2 hook installer | [#37](https://github.com/alxbra/agent-status-tiles/pull/37) | `a6778ad` |
| 4 observation | [#38](https://github.com/alxbra/agent-status-tiles/pull/38) | `a7044a7` |
| 5 connect | [#39](https://github.com/alxbra/agent-status-tiles/pull/39) | `a66f805` |
| 6 binary override | deferred | |

Still open after these merges: the live verification matrix in section 5
(real Claude Desktop and terminal sessions, hook coexistence, restart, uninstall,
no Node/Python dependence), journal garbage collection for ended sessions
(`docs/claude-monitor.md`), `disableAllHooks` detection beyond the user-level
settings file (section 3.4), navigation (section 3.7), and the deferred
override. Sections 1 and 4 below are the pre-merge baseline this plan was
written against and are kept as written. Development runs need `build/hook-helper/<arch>/hook-helper`, which
requires a Rust toolchain; packaged builds carry it.

Draft for review. Scope: finish MVP Epic 5 (Claude Code Desktop and CLI),
return Settings to one row per provider that bundles its Desktop and CLI
surfaces (Epic 7 connect/disconnect/repair), and add the first Advanced path
override (a custom Codex CLI binary). Click-to-foreground navigation and
completion acknowledgement (Epic 6) are out of scope and stay unchecked.

Baseline: `origin/staging` at `a9084c1` (PR #34). Everything below builds on
the merged helper (PR #2), helper packaging (PR #9), hook-journal reader
(PR #12), runtime coordinator (PRs #20–#22), the Codex connect flow (PR #23),
the tab dock (PRs #31–#32), and the authoritative newest-cohort discovery
contract (PR #33). Nothing here changes the dock visuals.

## 1. What already exists and what is missing

Existing and reused as-is:

- `crates/hook-helper`: `hook-helper --provider claude --data-dir <abs>`, reads
  one hook JSON from stdin, journals a reduced record to
  `<data-dir>/journals/claude/<sha256(provider\0session_id)>.jsonl` with
  rotation and locking, always exits 0 silently.
- `src/main/providers/hooks/hook-journal-reader.ts`: bounded replay of those
  journals for explicit `(provider, nativeSessionId, baseName)` targets with
  inode-tracked cursors.
- `src/main/runtime/coordinator.ts`: `ProviderSurfaceMonitor` interface with
  the PR #33 `discover` contract (newest `RECENT_THREAD_DISCOVERY_WINDOW` = 25
  sessions, cohort is authoritative, unreported sessions are dropped whatever
  their status), `claude:desktop` and `claude:cli` partitions, baseline and
  cutoff handling, owner reconciliation, per-surface health, 2 s discovery and
  250 ms file polling, connect/disconnect.
- Tab dock: each tab shows lab icon, session title, and status icon, so the
  title we report is visible text, not just a tooltip.
- Settings: one row per provider since PR #35 (`codex`, `claude`); the Claude
  row renders as unavailable. The `Advanced` button exists but opens
  nothing. Desktop preferences persist display, reduced motion, and the
  recent-thread limit.
- Codex CLI binary resolution (`resolvePathCodexBinary`) already canonicalizes
  a candidate with `realpath`, requires a regular file, and checks file and
  directory modes; the monitors take a `resolveBinary` injection point.

Missing at the time of writing (the pre-merge baseline; see the status table above for what has since landed):

1. Runtime resolution of the packaged helper path (nothing in `src/` finds
   `Contents/Resources/hook-helper/<arch>/hook-helper` today).
2. Owned-hook installation, verification, repair, and removal in
   `~/.claude/settings.json`.
3. Claude session discovery and journal-to-`SessionEvent` normalization.
4. `ClaudeDesktopMonitor` and `ClaudeCliMonitor` registered with the
   coordinator.
5. Desktop-versus-terminal ownership attribution.
6. One `Codex` row and one `Claude Code` row, each connecting both surfaces,
   with Connect/Disconnect/Repair and a partial-availability rule.
7. An Advanced screen with the Codex CLI binary override.

## 2. Verified facts the design relies on

Checked on this machine on 2026-09-17 (Claude Desktop 2.110.1, CLI 2.1.272) and
against the current hooks documentation:

- Desktop and CLI share `~/.claude/settings.json`, so one hook set serves both
  surfaces. The user's file currently has no `hooks` key.
- Hook commands inherit the launching app's environment. A Desktop-hosted
  session carries `__CFBundleIdentifier=com.anthropic.claudefordesktop` and
  `CLAUDE_CODE_ENTRYPOINT=claude-desktop`. Terminal-launched sessions carry the
  terminal's bundle identifier in `__CFBundleIdentifier` (the identifiers
  already fixed in `docs/navigation.md`). These variables are observed rather
  than documented, so the design validates them against a fixed allowlist and
  otherwise records nothing (see 3.1).
- Hook input always includes `session_id`, `cwd`, `hook_event_name`, and
  `prompt_id` after the first prompt. Subagent hooks reuse the parent
  `session_id` and add `agent_id`. There is no turn id; `prompt_id` is the
  turn key.
- `Stop` fires only when a turn finishes, never at a permission prompt or an
  `AskUserQuestion`. `stop_hook_active: true` means another stop hook is
  already continuing the turn, so that `Stop` is not a completion.
- `PermissionRequest`, `PreToolUse` for `AskUserQuestion`, `Elicitation`, and
  `Notification{permission_prompt|elicitation_dialog}` are the waiting signals.
  `StopFailure` is the turn-failure signal. `SessionStart.source` is one of
  `startup|resume|clear|compact|fork`; `SessionEnd.reason` is one of
  `clear|resume|logout|prompt_input_exit|other`.
- Settings changes are picked up by running sessions through a file watcher,
  so the "restart existing sessions" hint from the MVP plan is shown only if
  live verification proves a pre-install session stays silent.
- `disableAllHooks: true` at any settings level silently disables our hooks.
- The undocumented registry `~/.claude/sessions/<pid>.json` (pid, entrypoint,
  cwd, status, name) exists but is not used: it is undocumented, only covers
  live processes, and its `name` may be prompt-derived. Recorded as rejected.

## 3. Design decisions

### 3.1 Ownership attribution: helper reads two environment variables, keeps only allowlisted values

The helper adds optional fields to its record (schema stays version 1,
additive; the reader projects them and keeps rejecting unknown keys):

| Field | Source | Allowed values |
|---|---|---|
| `host` | `__CFBundleIdentifier` | `claude-desktop`, `terminal`, `iterm2`, `ghostty`, `warp`; omitted for anything else |
| `entrypoint` | `CLAUDE_CODE_ENTRYPOINT` | `claude-desktop`, `cli`; omitted otherwise |
| `is_subagent` | presence of `agent_id` in hook input | boolean |
| `session_source` | `SessionStart.source` | the five documented values |
| `end_reason` | `SessionEnd.reason` | the five documented values |

Surface rule: `host == claude-desktop` or `entrypoint == claude-desktop` gives
`desktop`. Everything else gives `cli`, with the terminal owner recorded when
`host` is one of the four terminals and `unknown` otherwise (for example a
session launched from an IDE terminal or over SSH). The raw variable values
are never journaled; an unrecognised value produces no field at all. No
process-ancestry walking, no Accessibility permission, no shell commands.

### 3.2 Discovery: bounded listing of the app's private journal directory

The journal reader needs explicit targets and file names are one-way hashes,
so the monitor lists `<userData>/journals/claude/*.jsonl` (regular files only,
no symlinks, bounded count), reads the first complete record of each active
file to learn `session_id` and `host`/`entrypoint`, verifies
`makeHookJournalBaseName('claude', id)` equals the file name, and keeps only
the journals whose surface matches the monitor's own key. It never scans the
user's home directory and needs no helper-side index.

Following PR #33: each monitor reports the newest `RECENT_THREAD_DISCOVERY_WINDOW`
(25) matching journals by active-file mtime, excluding any whose latest record
is `SessionEnd`, and the coordinator treats that page as the complete cohort.
So an ended session disappears on the next 2 s discovery whatever its status,
exactly as an archived or aged-out Codex thread does, and reappears if the
same session id is resumed. Sessions killed without `SessionEnd` keep their
last state until they age out of the window; silence is never interpreted.

Per source: `title` = latest `project_name` (project folder name, the plan's
fallback title rule; it is now visible tab text), `updatedAt` = mtime,
`isTopLevel` = true, `isArchived` = false, `endOffset` = active file size so
the coordinator's baseline cutoff and `readComplete` rules hold; archive files
are covered by the reader's inode-tracked cursors.

A session that moves between surfaces (`/desktop`, `/resume`) shows up in the
other monitor's cohort once its newest record carries the new host; the
coordinator's owner reconciliation already keeps one tile on the most recently
confirmed surface, and the old surface drops it on its next discovery.

### 3.3 Event normalization

`journal event -> SessionEvent`, keyed by `sessionId = claude:<session_id>` and
`turnId = prompt_id` (fallback: synthesized from the last `UserPromptSubmit`
receipt time for the session):

| Journal event | SessionEvent |
|---|---|
| `SessionStart` | none (discovery only); `source: resume` keeps the existing record |
| `UserPromptSubmit` | `turn-started` |
| `PreToolUse` / `PostToolUse` (not `AskUserQuestion`) | `activity` |
| `PermissionRequest`, `PreToolUse{AskUserQuestion}`, `Elicitation`, `Notification{permission_prompt, elicitation_dialog}` | `input-requested`; `callId` = `tool_call_id`, `elicitation_id`, or a notification-derived id |
| `PostToolUse{AskUserQuestion}`, `PostToolUse` for a pending call id, `ElicitationResult`, `Notification{elicitation_complete, elicitation_response}`, next `PreToolUse`/`Stop` while a request is open | `input-resolved` |
| `Stop` with `stop_hook_active` false or absent | `turn-completed`; `completionId` = sha256(session_id, prompt_id, timestamp) |
| `Stop` with `stop_hook_active` true | `activity` |
| `StopFailure` | `turn-failed` |
| `PostToolUseFailure` | `activity` (ordinary tool failures never redden the session) |
| `SessionEnd` | none; affects the discovery cohort |
| any event with `is_subagent` true, except waiting signals | `activity` on the parent |

Duplicates are dropped by the reader's `eventIdentity`; stale turns by the
reducer's current-turn rule. `Notification{idle_prompt}` is ignored for state.

### 3.4 Hook installation is owned, idempotent, and additive

- Target file: `~/.claude/settings.json` (user level, shared by both surfaces).
- Helper path: `process.resourcesPath/hook-helper/<process.arch>/hook-helper`
  when packaged, `build/hook-helper/<arch>/hook-helper` in development; must
  be a regular executable file.
- Installed events: exactly the helper allowlist (`SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `Elicitation`,
  `ElicitationResult`), no matcher, one command hook each with `timeout: 5`
  and `async: true` (verify during E2E that async is accepted for every event
  and that nothing is fed back to the agent; the helper never prints, so the
  synchronous fallback is equally safe).
- Ownership marker: the command executable path ends with `/hook-helper` and
  its arguments contain `--provider claude`. Use the exec-form `args` array if
  the installed Claude version accepts it, so the app path with spaces needs no
  shell quoting; otherwise a quoted single `command` string.
- Write policy: parse, add or replace only owned entries, keep every other key
  and hook in place and in order, write atomically with a temp file and rename,
  mode 0600. An unparsable file is never rewritten; it surfaces as one
  actionable error sentence. Removal deletes only owned entries and drops empty
  event arrays and an empty `hooks` object.
- Verification (used by health and Repair): helper exists and is executable,
  owned entries are present and point at the current helper path,
  `disableAllHooks` is not true in the user-level file. Claude also honours
  `disableAllHooks` from project, local, and managed settings, which this
  check does not read; a project-level switch therefore silences the hooks
  while the row reports healthy. Detecting it (or the hooks' silence) is a
  follow-up.

### 3.5 One row per provider, both surfaces behind it

`SettingsConnectionKey` becomes `codex | claude`, labelled `Codex` and
`Claude Code`, which is the original MVP mockup. Internally nothing merges:
partitions, baselines, cursors, owners, and health stay per surface.
`CONNECTION_TARGETS` maps each key to two surfaces and Connect calls the
coordinator's per-surface connect for each; if the second fails, the first is
rolled back so a row is never half-connected by accident.

Row state derives from the two surfaces:

- **Connected** when at least one surface is available. A surface whose
  prerequisite is absent (no ChatGPT app bundle, no `codex` on PATH or at the
  override path) reports `unavailable` quietly instead of `error`, with no
  retry storm and no sentence, so a Desktop-only Codex user sees a clean row.
- **One actionable sentence** appears only when every surface of the provider
  is unavailable, or when a present surface is in `error` (for example a
  broken hook install or an app-server that will not start).
- **Disconnect** disables both partitions; for Claude it also removes the
  owned hooks. The confirmation dialog states the concrete change.
- **Repair** (dropdown item on a connected row) re-resolves binaries or
  rewrites owned hooks and restarts the provider's surfaces.

Migration: an existing checkpoint with only one Codex partition enabled shows
the row as Connected, and the other partition is enabled on the next launch
through the normal pending baseline, so nothing historical turns green. Per-surface opt-out is deferred; if it is ever needed it belongs under
Advanced, not in the main list.

Claude: both monitors verify the same hooks, so the Claude row has one
install, one Repair, and no "remove hooks only after both rows" rule.
`MVP_PLAN.md` §2.5 already shows this two-row layout; `AGENTS.md` and the PR
#23 row split are superseded, authorized by the product owner on 2026-09-17.
Schema change touches `src/shared/settings.ts` (keys and `isSettingsState`
arity), `src/main/index.ts`, `src/preload`, `App.tsx`, `SettingsView.tsx`,
the settings fixture, and `settings-view.spec.ts` (which asserts three rows).

Health: each Claude monitor's `start()` runs the verification in 3.4 and
throws typed errors (`claude-helper-missing`, `claude-hooks-missing`,
`claude-hooks-disabled`, `claude-settings-unreadable`), which the coordinator
turns into surface `error` health with retry. No events yet is healthy.

### 3.6 Advanced: custom Codex CLI binary (deferred)

Deferred by the product owner on 2026-09-17; kept here as the agreed design
for when it is picked up.

Users with several Codex installs (npm global, Homebrew, a version manager)
may want the companion to talk to a specific one. This is the first entry of
the Advanced screen the MVP plan reserves for path overrides.

- **Setting**: `codexCliBinaryPath`, optional absolute path, persisted in the
  desktop preferences store like the other preferences, applied immediately.
- **Validation** reuses the PATH resolver's checks: canonicalize with
  `realpath`, require a regular executable file with sane file and directory
  modes, reject relative paths and anything under the app's own bundle. The
  resolved path is then used exactly as a PATH hit would be, spawning
  `app-server` with an argument array.
- **Precedence**: override, else PATH lookup. An override that fails
  validation makes `codex:cli` `unavailable` with one sentence ("Codex CLI
  path is not an executable file") and never silently falls back to PATH,
  because the user asked for that installation specifically.
- **Apply**: changing the value stops and restarts only the `codex:cli`
  surface through the existing per-surface lifecycle; other surfaces keep
  running.
- **UI**: stock shadcn input with a native file picker button, one label
  (`Codex CLI`), no description, error text only when invalid. The file picker
  runs in the main process; the renderer never receives filesystem access.
- **Not covered**: Codex Desktop keeps its signature-verified bundled binary
  (an override there would bypass the team-id check); Claude needs no binary
  override because hooks call our own helper. A `CLAUDE_CONFIG_DIR`-style
  settings-file override and a Codex home override fit the same screen later.
- **Version drift**: a pointed-at binary may speak an older app-server
  protocol; the catalog client's existing format diagnostics surface that as
  an integration issue rather than guessing.

### 3.7 Out of scope

Click-to-foreground, completion acknowledgement on dispatch, and the
terminal-selection fallback stay excluded, as `NEXT_EPIC_PROMPT.md` states.
The `host` field recorded in 3.1 is what a later navigation slice will consume.

## 4. PR sequence

Each PR: one concern, tests included, format/lint/types/unit/build/E2E, one
CodeRabbit pass, two QA passes, evidence row in `MVP_PLAN.md`.

| # | Branch | Content | Main files |
|---|---|---|---|
| 1 | `feat/claude-hook-identity` | Helper records `host`, `entrypoint`, `is_subagent`, `session_source`, `end_reason` from allowlists; reader projects them; docs and native tests | `crates/hook-helper/src/lib.rs`, `crates/hook-helper/tests/native.rs`, `src/main/providers/hooks/hook-journal-reader.ts`, `docs/hook-helper.md`, `docs/hook-journal-reader.md` |
| 2 | `feat/claude-hook-installer` | Helper path resolver; owned-hook install/verify/remove for `~/.claude/settings.json` with a HOME override for tests; no UI wiring | `src/main/providers/claude/helper-path.ts`, `src/main/providers/claude/hook-installer.ts`, `tests/unit/claude-hook-installer.test.ts` |
| 3 | `feat/bundle-provider-rows` | `codex`/`claude` keys, two-surface connect with rollback, quiet-unavailable rule, migration of one-partition checkpoints, Repair channel, dialog copy, `AGENTS.md` line, settings E2E (Codex only; Claude row still unavailable) | `src/shared/settings.ts`, `src/shared/ipc.ts`, `src/main/index.ts`, `src/main/settings-ipc.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`, `src/renderer/settings/SettingsView.tsx`, `tests/fixtures/settings-view/main.tsx`, `tests/e2e/settings-view.spec.ts`, `AGENTS.md` |
| 4 | `feat/claude-observation` | Journal discovery honoring the PR #33 cohort contract, event normalizer, `ClaudeSurfaceMonitor` with Desktop and CLI subclasses, coordinator registration, test env override for the journal root, sanitized journal fixtures, native E2E writing journals directly and asserting working, waiting, unread, error, ended-session pruning, restart replay, and baseline suppression | `src/main/providers/claude/{discovery,events,surface-monitor,desktop-monitor,cli-monitor}.ts`, `src/main/index.ts`, `tests/unit/claude-*.test.ts`, `tests/fixtures/claude/`, `tests/e2e/claude-*.spec.ts` |
| 5 | `feat/claude-connect` | Enable the Claude row: connect installs hooks and both partitions, disconnect removes owned hooks, Repair rewrites them, health-to-sentence mapping, settings E2E | `src/main/index.ts`, `src/main/providers/claude/hook-installer.ts`, `tests/e2e/settings-view.spec.ts`, `tests/unit/settings-connection.test.ts` |
| 6 (deferred) | `feat/codex-cli-binary-override` | Advanced screen with the `Codex CLI` path field and native picker, preference persistence, override resolver, `codex:cli` restart on change, unit and settings E2E | `src/main/desktop-preferences.ts`, `src/main/providers/codex/configured-binary-resolver.ts`, `src/main/index.ts`, `src/shared/settings.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/settings/AdvancedView.tsx`, tests |
| 7 | `docs/claude-epic-evidence` | Live Desktop and terminal validation record, Epic 5 and 7 checkbox updates | `MVP_PLAN.md` |

PRs 1, 2, and 3 are independent of each other; 4 needs 1; 5 needs 2, 3, and 4;
6 needs 3 and can run in parallel with 4 and 5.

Approximate handwritten size: PR 1 about 250 lines, PR 2 about 350, PR 3 about
300, PR 4 about 400 plus fixtures (split discovery from the monitor if it
exceeds that), PR 5 about 200, PR 6 about 350.

## 5. Live verification matrix (Epic 5 gate)

Run after PR 5 on this Mac, both surfaces, with private content never captured
(the Codex override checks at the end form a separate gate for the deferred
PR 6):

- Fresh Connect from a settings file with no `hooks` key and from one with an
  unrelated hook present; confirm only owned entries are added and the other
  hook survives Disconnect.
- Codex row with the CLI binary absent (Desktop-only); confirm quiet
  unavailability.
- Desktop session and Terminal, iTerm2 (if installed), Ghostty, and Warp
  sessions: prompt (working), permission prompt (waiting), question tool
  (waiting), approval (working), completion (unread), API failure (error),
  new turn clearing error, subagent activity not completing the parent, exit
  removing the tab within 2 s.
- Companion closed during a turn, then relaunched: replay yields the right
  state with no duplicate completion and no historical unread on first
  connect.
- Session resumed via `/resume` and moved via `/desktop`: single tab, owner
  follows the latest surface.
- Malformed and oversized hook input, concurrent sessions, journal rotation
  under a long tool-heavy turn, `disableAllHooks` set, helper path moved
  (Repair), and uninstall.
- Confirm hooks never delay or alter agent work (async, silent helper) and the
  app runs without user-installed Node.js or Python.

PR 6 gate (deferred): a valid override pointing at a second Codex install and
an invalid override; confirm the override being used and the single error
sentence.

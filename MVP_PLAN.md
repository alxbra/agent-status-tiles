# Agent Status Tiles — MVP Implementation Plan

**Document:** `MVP_PLAN.md` in the project root.  
**Document status:** The native overlay implementation batch through PR #18 is merged into `staging` (PR #18 merge `9dc43416eb6e060ded084977717ae35a7bb2ca35`). The renderer bridge, portal hit-region synchronization, selected-display preferences, deliberate keyboard entry, and lifecycle recovery are implemented and reviewed. Physical multi-display, Spaces/full-screen, real sleep/wake, and arbitrary underlying-application click-through acceptance remain pending, as do live provider wiring, cross-file baseline coordination, signing, and release gates; this document does not claim MVP completion.
**Repository:** [alxbra/agent-status-tiles](https://github.com/alxbra/agent-status-tiles)

## 1. Product and release target

Build a minimal desktop companion that shows what local AI agents are doing without requiring the user to keep their harnesses visible.

The first publishable release targets macOS and supports:

- Codex Desktop.
- Codex CLI.
- Claude Code local sessions in Claude Desktop.
- Claude Code terminal sessions.

Each eligible top-level thread or task is tracked locally. The overlay considers the five most recently updated items across connected harnesses by default, configurable from one to ten. Spawned subagents remain represented by their parent.

The main interface is a compact dynamic island: one black, notch-style shape hanging from the top center of the selected display, over the menu bar. It shows two columns, Codex on the left and Claude on the right, each with one status dot (needs input, working, or idle) beside the harness name, and it plays a short success cue when a turn finishes. Clicking a column brings that harness's Desktop app forward and selects its most relevant thread where supported. The user authorized this island on 2026-09-23, replacing the document-tab dock of 2026-09-17 (which had itself replaced the rounded-square tiles and Dock-style magnification); the reference states render from `tests/fixtures/dynamic-island.html`. The same day, the user split it into per-harness columns and removed the done state. The island does not expand yet.

### Fixed scope

- Show the most recently updated eligible items, including idle and acknowledged completions.
- Keep working, waiting, failed, and unread-completed statuses distinct.
- Use one selected display, defaulting to the primary display.
- Appear across macOS Spaces and full-screen applications.
- Use Electron, React, TypeScript, Tailwind CSS, and stock shadcn/ui.
- Keep all monitoring and persistence local.
- Deliver signed, notarized macOS installers ready for publication.
- Integrate completed work continuously through small PRs targeting `staging`.

### Current runtime readiness after PR #18

The merged application then mounted `StatusTiles` (since replaced by the
dynamic island) in the sandboxed native overlay
through a typed, sender/frame-validated preload and IPC bridge. It projects only
bounded session metadata, keeps zero-session production state hidden,
synchronizes tile and portal hit regions, persists the selected display and
reduced-motion preference, supports deliberate menu-bar keyboard entry, and
recovers from window closure, renderer crash/load failure, display events,
resume, and activation without duplicate controllers or stale listeners, and
tears down cleanly on shutdown. Sanitized test-only snapshots verify native
0/1/12/30-session behavior; no fake production activity is shipped.

The application is still not an end-to-end provider-connected companion. The
session reducer, persistence, Codex readers, hook-journal reader, helper, and
navigation primitive remain independently tested rather than coordinated into
live runtime state. The next bounded handoff is [live local provider
coordination](NEXT_EPIC_PROMPT.md). Physical overlay acceptance and all live
provider, baseline, signing, and release gates remain unchecked.

### Deferred

Windows and Linux releases, other screen edges, manual pinning, project grouping, cloud/SSH monitoring, IDE-specific integrations, usage dashboards, dictation, task execution controls, sounds beyond the finished-turn cue, account systems, and automatic updates.

Public release publication and promotion from `staging` to `main` are separate final release actions. This implementation ends with a tested release candidate ready to publish.

## 2. Strict UI contract

These requirements are acceptance criteria. Agents must not embellish or reinterpret them.

### 2.1 Visual references

Use the ambient color feedback and compact interaction model of [Codex Micro](https://openai.com/supply/co-lab/work-louder/).

Reuse the exact palette and status meanings from [the existing theme module](/Users/alex/Projects/codex-status-actions/src/theme.ts). Reuse applicable logic and original artwork from that Apache-2.0 project with attribution; do not copy proprietary hardware assets.

| State | Color | Compact island |
|---|---|---|
| Idle / unavailable | `#F1F1ED` | Hidden column; the sleeping frenchie's blaze when no harness is active |
| Completed | `#8FEA98` | Pulses green for 10 s, then the harness's current tone (hidden when idle) |
| Working | `#8DCEF5` | Pulsing blue dot |
| Waiting for input | `#FF8A3D` | Orange dot |
| Error | `#FF6B73` | Reads as idle until the island expands |

Session state still distinguishes unread completions, unavailable items, and errors; the compact island shows all three as idle. Unavailable is used when a previously observed item can no longer be observed reliably, and errors keep their color for the future expanded island.

### 2.2 Compact island

- The island is one black (`#000`) shape hanging from the top edge of the selected display, centered horizontally over the menu bar's empty center: **32 CSS px** tall, a flat top with **8 CSS px** concave shoulders on both sides, and a fully rounded bottom (16 px radius).
- Its width follows its visible columns, or the sleeping frenchie, with **14 CSS px** of horizontal padding and a minimum of **48 CSS px**.
- The native window is **360 × 56 CSS px** at the display's top edge and sits above the menu bar at the status window level. Transparent space outside the island surface passes mouse events to applications underneath; the island surface is the only native hit region.
- No title, toolbar, legend, settings button, icon, frosted backdrop, or native vibrancy window.
- If no sessions qualify, hide the island completely. The menu-bar icon remains available.
- If sessions qualify but no harness is active, the island shows only a sleeping pixel frenchie (the user asked for this empty state on 2026-09-25 and the same day replaced the first cat with their own fawn French bulldog): 12 rows on a 2 CSS px grid in one of five poses (head on paws, curled up, belly up, in a donut bed, sploot), picked at random each time the island falls asleep and never the same pose twice in a row. Its colors (`src/renderer/island/frenchie-poses.ts`: fawn, near-black ears and eye patches, grey muzzle, white blaze and chest, and a grey bed) are decoration and never reuse a status color. It breathes in two frames (one pixel row taller, 2.4 s), shows a twitch frame (an ear flick or a paw moving) for the last half second of every 7.2 s, and sleeps under two 5-pixel z's that drift up and fade in turn, in the names' former gray. It is not a button and opens nothing; keyboard entry ends at once. Reduced motion holds it still in its resting frame under one z.

### 2.3 Harness columns

The island shows one column per active harness (the user split it per harness on 2026-09-23 and hid idle harnesses on 2026-09-25), hugging its center with a **28 CSS px** gap when both show and centered when one shows:

- Codex on the left: an **8 CSS px** dot, then `Codex`, **8 CSS px** apart.
- Claude on the right: its dot, then `Claude` (the user moved the dot to the left on 2026-09-25).

Each dot shows its harness's most important recent thread:

1. Orange when one of its threads needs input.
2. Else blue, pulsing (a breathing dot with a soft expanding ring), while one of its threads works.
3. Else the column is hidden, because the harness is idle.

There is no done state: a finished, failed, or unavailable thread counts as idle. Nothing else appears in the island: no thread titles, icons, counts, badges, or decorative copy beyond the sleeping frenchie. Both names use the bundled Fira Code typeface at weight 500 and 12 px, each in its dot's color (the user asked for this on 2026-09-25).

When a turn finishes live (a thread the island has seen gains a new, unacknowledged completion), the island plays the `success` cue from [Cuelume](https://cuelume.dev/). Its recipe is vendored in `src/renderer/island/success-cue.ts` (MIT) and synthesized locally with Web Audio, with no file loaded, because the Cuelume package refuses to play before a user gesture and the overlay never takes focus; the overlay window also allows audio without a gesture. That harness's column pulses green (`#8FEA98`) for **10 seconds** (lengthened from 5 on 2026-09-25) and then shows its current tone, blue or hidden (the user extended the cue to every finished turn on 2026-09-23). Finishing again restarts the 10 seconds. The green ends early, for good, once the harness's tone changes from the one it finished with (it starts or stops working, or a question arrives); a harness waiting for input stays orange, because a question outranks a finished turn. The island remembers up to 256 threads' completions, including threads that left the recent list. Completions that existed before it first saw a thread, and replayed history that arrives already acknowledged, never sound; a brand-new thread whose first turn ends before the island ever shows it is also silent, as is a turn that finished while its thread was pruned from the runtime's recent set, because the runtime baselines a returning thread's history as acknowledged.

Motion: the width changes with one **420 ms** spring transition, and a dot scales in whenever its tone changes. Reduced motion stops the pulse, the sleeping frenchie's breath, twitch, and z's, and every transition, but keeps the sound.

The island does not expand yet. An expanded view needs explicit product authorization.

#### Interaction mockup

```text
          menu bar ─────────╮                       ╭───────── menu bar
                        ╰─ frenchie z ─╯               both idle: a frenchie sleeps
                        ╰─ ◉ Codex ─╯                  Codex working, Claude idle (hidden)
                  ╰─ ◉ Codex      ◉ Claude ─╯          Claude finished its only turn: sound, green 10 s, then hidden
                  ╰─ ◉ Codex      ◉ Claude ─╯          both working
                  ╰─ ◉ Codex      ◉ Claude ─╯          Codex finished one of two: sound, green for 10 s
                        ╰─ ● Codex ─╯                  Codex needs input (orange), Claude idle
```

The notes to the right explain the mockup; they never appear in the island.

### 2.4 Recency, opening, and errors

- Sort eligible items by confirmed provider update or task activity, newest first, with a stable ID tie-break. Local acknowledgement and error dismissal do not change recency.
- Apply the global Recent threads limit (default five, range one to ten) across connected harnesses, including idle items; the island summarizes only those items.
- Items outside the configured recent limit remain in local state and return when they become recent enough.
- Each column is a button for its harness (the user asked for click-to-open on 2026-09-23, and on 2026-09-25 for every click to open the harness's Desktop app). A click opens that harness's Desktop app at the thread captured on pointer-down: the one waiting for input, else the one that just finished while its green cue shows, else the newest working one. An idle harness shows no column, and the sleeping island opens nothing.
- Every thread the island shows is openable, and main opens only a top-level, unarchived thread in the island's current state, through the navigator in `docs/navigation.md`: a Codex Desktop thread with a task UUID selects the exact thread; any other Codex thread, CLI threads included, activates Codex Desktop; every Claude thread, CLI threads included, activates Claude Desktop. Terminals are never brought forward. If the Desktop app is missing, the click fails and changes nothing.
- Opening a thread with an unread completion (the just-finished one) acknowledges the completion the click saw, only after navigation was dispatched and only if it is still current; a failed or unavailable navigation acknowledges nothing. Unread completions otherwise stay in session state, where they no longer show.
- Errors remain in session state until a new turn. Explicit dismissal stays available over IPC for the future expanded island; the compact island has no context menu.
- Dismissal affects only the companion's display, never the underlying task.

Session titles stay in local state for navigation and the future expanded island; the compact island never shows them. For Codex, use a validated catalog `name`, falling back to the project folder name. For Claude Code, use the session's own name from Claude's per-process session registry (conversation-derived or user-set; Claude's folder-based placeholders are ignored), falling back to the project folder name (the repository name for a worktree). The user authorized storing these bounded harness-chosen names locally on 2026-09-17; never derive a title from `preview`, a transcript, a hook payload, or a rollout payload.

### 2.5 Settings

Use stock shadcn/ui components and their standard styling. Follow the official [Vite installation](https://ui.shadcn.com/docs/installation/vite).

Defaults:

- Standard shadcn neutral theme.
- System light/dark appearance.
- Standard font, control sizes, spacing, radii, borders, and focus rings.
- No custom component skins.
- No edits to generated shadcn primitives to satisfy cosmetic review suggestions.

Settings contain only:

```text
Settings

Codex                         [Connect]
Claude Code                   [Connect]

Display                       [Primary ▾]
Launch at login               [       ○]
Reduce motion                 [       ○]

Advanced                            ›
```

Connected rows replace `Connect` with a compact status and an appropriate action menu. Each provider row bundles that provider's Desktop and CLI surfaces: Connect enables both surfaces and Disconnect disables both, while the surfaces keep separate partitions, baselines, cursors, and health underneath. A row reads `Connected` while at least one of its surfaces is monitoring; a surface whose installation is absent stays quietly unavailable behind it, and a checkpoint from before bundling that enabled only one surface completes the bundle on the next launch through the normal pending baseline.

Advanced contains path overrides and diagnostics export. Connection repair is a `Repair` item in a connected row's action menu, and hook removal is part of Disconnect; both confirmation dialogs state the actual configuration change (Connect installs this app's hooks into Claude Code settings, Disconnect removes only them).

Rules:

- One concise label per setting.
- No introductory copy, cards repeating section titles, decorative badges, descriptions, or sublines.
- Show one actionable error sentence only when a connection or setting actually fails: when a monitored surface reports an error, or when every surface of a connected provider is missing. Do not show a persistent partial-coverage warning for an otherwise healthy Codex connection, and do not report one absent surface while the other monitors.
- Use brief confirmation text when installing or removing hooks; explain the actual configuration change.
- Keep diagnostic detail behind an explicit action.
- Saving settings is immediate; no redundant Save button.

### 2.6 Accessibility and desktop behavior

- Hover must not activate the app or steal keyboard focus.
- Support keyboard entry through the menu-bar action, which focuses the column of the harness most worth opening (waiting for input, then working); Tab moves between the columns, Enter opens a column's thread like a click, and Escape leaves keyboard mode.
- Each column's accessible name is its harness and tone, for example `Codex working`; the columns sit in a group named `Agents`, and no name includes a thread title.
- Respect system reduced-motion settings; allow explicitly enabling reduced motion.
- Reduced motion stops the pulse and every island transition.
- Display disconnection moves the island to the primary display; reconnecting restores the selected display.
- Sleep/wake must restore monitoring and placement.
- Test actual macOS window behavior; browser screenshots alone are insufficient. Electron provides the relevant workspace and mouse-passthrough controls, but their combination needs native verification. [Electron window documentation](https://www.electronjs.org/docs/latest/api/base-window)

## 3. Architecture and integration contracts

### 3.1 Application structure

Use:

- Electron main process for integrations, state, persistence, navigation, and window placement.
- React renderer for the island and settings.
- A narrow, typed preload bridge.
- Vite-based builds.
- Tailwind and stock shadcn/ui.
- Vitest for state and adapter tests.
- Playwright’s Electron support for application E2E tests.
- electron-builder for packaging.
- pnpm with a committed lockfile.

Use a small bundled Rust helper for receiving harness hook input and writing reduced local events. It must not require users to install Node.js, Python, or Rust.

Keep OS-specific navigation and window operations behind explicit interfaces. Implement macOS now; do not add speculative Windows/Linux behavior.

```text
Codex catalog + local events ─┐
                             ├─ provider adapters ─ session store ─ preload ─ island
Claude hook events ──────────┘                          │
                                                      ├─ settings
                                                      └─ macOS navigation
```

### 3.2 Shared types

```ts
type Provider = "codex" | "claude";
type Surface = "desktop" | "cli";

type SessionStatus =
  | "idle"
  | "working"
  | "needs-input"
  | "unread"
  | "error"
  | "unavailable";

interface SessionSnapshot {
  id: string; // Namespaced by provider and native thread/task ID.
  provider: Provider;
  surface: Surface;
  title: string;
  status: SessionStatus;
  updatedAt: number;
  lastTurnStartedAt: number;
  completionId?: string;
  isTopLevel: boolean;
  isArchived: boolean;
  canOpen: boolean;
}

interface ProviderAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(
    listener: (sessions: readonly SessionSnapshot[]) => void
  ): () => void;
  openSession(id: string): Promise<{
    opened: boolean;
    target: "session" | "application";
  }>;
}
```

Persist provider-native IDs separately from display titles. Codex uses the catalog thread ID for deduplication and navigation; the rollout session ID is a separate, validated file identity. Retain the most recently confirmed owning surface.

Renderer commands are limited to:

- Read/subscribe to snapshots.
- Open a session.
- Dismiss a local error marker.
- Read/update settings.
- Connect, repair, or disconnect integrations.
- Export reduced diagnostics.

The renderer never receives arbitrary filesystem access, shell execution, hook payloads, or raw transcripts.

### 3.3 Status behavior

- Prompt/turn start → working.
- Approval or question opened → waiting.
- Matching input resolution or confirmed resumed activity → working.
- Confirmed successful turn completion → unread.
- Terminal turn failure → error.
- Ordinary recoverable tool failures do not automatically make the entire session red.
- Acknowledged completion → idle; it remains eligible for the recent-item limit.
- New turn clears prior completion acknowledgement and prior terminal errors.
- Archived sessions disappear.
- Items disappear, whatever their status, when a completed catalog listing no longer reports them: the newest live page is authoritative, and a thread reappears when it is updated again. Idle and acknowledged items remain visible while still reported and within the recent-item limit.
- Ignore stale events from previous turns.
- Parent completion must not be inferred from a subagent stopping.
- Silence alone must not be interpreted as success, failure, or a stopped session.

Persist unread markers, acknowledgement IDs, ordering, settings, and event cursors atomically. First installation must not turn historical completed sessions green.

A monitoring failure belongs to integration health. Do not mark every session as failed. Previously visible sessions with uncertain state become unavailable, and the menu-bar/settings UI exposes the connection problem. A missing installation of one surface behind a connected provider row is not a failure and is not reported while another surface of that provider monitors; see §2.5.

### 3.4 Codex adapter

Adapt the existing project’s catalog client, incremental event reader, reducer, and navigation approach rather than introducing a second independent implementation.

- Use local app-server queries for task metadata. Discovery reads one live `thread/list` page of the newest threads (`RECENT_THREAD_DISCOVERY_WINDOW`, the shared 25-record window every provider monitor reports, sorted by `updated_at` descending) and treats that page as the complete cohort; it never lists archived threads and does not follow continuation cursors. The catalog is re-read every 2 s while the 250 ms file poll carries live status between listings.
- Use observed local task events for work performed in another Codex process.
- Use explicitly installed and trusted hooks to improve approval detection.
- Include Desktop and CLI top-level threads, including user-created forks; exclude archived, ephemeral, and spawned child threads. Archived threads are never requested, so a thread archived while visible leaves the live page and is dropped on the next discovery like any other unreported session. Use the catalog thread `id` as identity and validate rollout events against the separate session ID.
- A Codex Desktop thread has source `vscode` and a Desktop originator: `Codex Desktop`, or `codex_work_desktop`, which Desktop builds write from 2026-09-24 on (`src/main/providers/codex/originators.ts`). For a catalog record with `vscode` source but no originator, require the validated rollout SessionMeta to confirm `vscode` and a Desktop originator before showing it. Report missing or contradictory proof as incomplete coverage.
- Replay at most the ten newest active Codex rollouts per surface while retaining older qualified task metadata. A task entering the replay cohort later must baseline its previously unread history before showing new activity. Skip an oversized rollout record whose bounded envelope prefix proves it activity-only (large tool output, completed items, compaction history); quarantine the rollout for any other oversized record and report incomplete coverage without blocking other tasks.
- Keep private/local file parsing isolated and covered by recorded, sanitized fixtures.
- Detect unsupported formats and surface an integration issue instead of guessing.
- Do not start, resume, or modify tasks to observe them.

The existing architecture explicitly documents why an independently started app-server cannot supply another process’s live task state. [Existing architecture](/Users/alex/Projects/codex-status-actions/docs/ARCHITECTURE.md)

Hook setup must preserve unrelated definitions and honor Codex’s trust flow. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

### 3.5 Claude Code adapter

Use shared user-level hooks for local Desktop and terminal sessions. Claude documents that both surfaces use hooks and shared settings. [Claude Desktop configuration](https://code.claude.com/docs/en/desktop)

Normalize session start/end, prompt submission, input requests/resolution, completed turns, and terminal failures. Use permission and tool lifecycle events for immediate input detection; notification events are supplementary because some are conditional or delayed. A `Stop` callback alone must not be treated as definitive completion when another hook continues the turn. [Claude hook reference](https://code.claude.com/docs/en/hooks)

The helper must:

- Retain only session/turn identifiers, event kind, timestamp, project identity, and navigation metadata.
- Discard prompts, tool arguments, output, answers, and transcript content.
- Write bounded local event journals under the app’s private data directory.
- Serialize concurrent writes and support safe rotation.
- Return success with no output even when the companion is stopped.
- Never return permission decisions or other output that alters the agent’s work.
- Support replay after companion restart without duplicate completions.

Existing Claude sessions may require a restart/resume to activate newly installed hooks. Expose this requirement only when applicable.

### 3.6 Navigation

The guaranteed action is **foreground the owning application**.

- Codex Desktop: use the validated task link from the existing project.
- Claude Desktop: activate Claude. Do not invent a session deep link.
- CLI (terminal) sessions: activate the harness's Desktop app, not the terminal (the product owner chose this on 2026-09-25, superseding terminal ownership, terminal activation, and the terminal-app selection).
- Never open a duplicate agent session or submit a command as a navigation fallback.
- Do not request Accessibility permission merely to satisfy basic navigation.

The published Claude link documentation describes opening chats and starting Code sessions; it does not establish a general existing-Code-session navigation contract. App activation is therefore the MVP guarantee. [Claude desktop links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)

### 3.7 Security and operational limits

- Enable context isolation and renderer sandboxing; disable Node integration.
- Validate IPC sender, command, and payload.
- Deny arbitrary renderer navigation and new windows.
- Open only validated application targets or approved URL schemes.
- Launch processes with argument arrays, never interpolated shell commands.
- Make hook installation/removal idempotent and preserve other tools’ settings.
- Keep hook commands stable across app upgrades.
- Use the existing app’s credentials indirectly through its supported local interfaces; never read authentication files.
- Store no prompt or transcript content and send no telemetry.
- Export diagnostics without session titles, project paths, credentials, or agent content.
- Bound event size, history retention, filesystem reads, and retry queues.
- Stop background animation work when the island is hidden.

## 4. PR and hardening workflow

### Repository bootstrap

Repository bootstrap is complete. The minimum initial commit contains the plan, project instructions, README, and ignore rules; `main` and `staging` were created from that commit. All subsequent implementation uses feature branches and PRs into `staging`.

Do not promote application code to `main` during MVP development.

### Required workflow for every PR

- [ ] Branch from the latest `staging`.
- [ ] Implement one bounded behavior change with its tests.
- [ ] Run formatting checks, lint, type checking, unit tests, build, and relevant E2E tests.
- [ ] Push and create a PR targeting `staging`.
- [ ] Run **exactly one completed CodeRabbit pass** against committed changes relative to `staging`.
- [ ] Critically triage every finding; fix valid issues and record reasons for rejecting others.
- [ ] Run QA/refactor pass 1 against the PR diff; fix valid findings and validate.
- [ ] Run QA/refactor pass 2 against the updated PR diff; fix valid findings and validate.
- [ ] Process unresolved review threads, summary comments, nitpicks, and outside-diff comments.
- [ ] Run final E2E tests against the resulting implementation; correct failures and rerun affected tests.
- [ ] Wait for required checks on the latest commit.
- [ ] Squash-merge into `staging`, verify the merge, and delete only the feature branch.
- [ ] Update this plan’s completion record with PR, merge SHA, test evidence, and remaining dependencies.

Use the [PR hardening workflow](/Users/alex/.codex/skills/create-pr/SKILL.md), with the user’s **one-pass CodeRabbit limit overriding its multi-pass defaults**. Apply [safe merge safeguards](/Users/alex/.codex/skills/squash-merge-pr-safe/SKILL.md).

```sh
coderabbit review --agent --base origin/staging --committed
```

Disable automatic CodeRabbit reruns so subsequent fix commits do not generate additional passes. Do not combine an automatic review with a second CLI review.

If CodeRabbit is unavailable, leave the PR pending and report the dependency. Never claim the required pass ran when it did not.

After post-review fixes, report “findings addressed and final checks passed”; do not claim CodeRabbit reviewed the final commit.

Review-thread replies follow the [comment-processing workflow](/Users/alex/.codex/skills/manage-pr-review-comments/SKILL.md). Release-blocking findings must be fixed before merge. Any exceptional valid deferral requires its prescribed Linear tracking.

### Small PR policy

Target one concern and roughly 150–400 handwritten changed lines where practical. Exclude lockfiles and generated shadcn components from that guideline.

Split an epic into additional PRs when needed. Do not make a single “entire MVP” PR. Re-run affected integration tests if `staging` changes before merge.

## 5. Checkable epics and tasks

Every epic ends with E2E verification, corrections, and the PR hardening/merge gate. Later agents must not check off an epic based solely on implementation or mocked screenshots.

### Epic 0 — Repository and delivery foundation

**PRs:** bootstrap, then `chore/app-foundation`.

- [x] Save this plan in the project root and add project instructions preserving its UI and review requirements.
- [x] Establish `main`, `staging`, and the feature-branch workflow.
- [x] Scaffold Electron, React, TypeScript, Vite, Tailwind, and the stock shadcn configuration. Generated shadcn primitives are not needed yet.
- [x] Add pnpm scripts for development, build, checks, tests, and packaging.
- [x] Add CI for lint, types, unit tests, build, and Electron smoke tests.
- [x] Configure one-pass CodeRabbit operation.
- [x] Add a test-only fixture source isolated from production data.
- [x] Add Apache-2.0 licensing and attribution for reused project code.
- [x] **E2E and corrections:** launch the built Electron application, open and close settings, verify single-instance behavior, fix failures, rerun, harden, and merge.

The synthetic/source-derived Codex rollout fixtures under `tests/fixtures/codex/` are a real test-only source and are isolated from production data. The browser-only settings and tile fixtures from merged presentation branches are not production data sources; controlled live-format capture and end-to-end app replay remain pending.

### Epic 1 — macOS overlay and menu-bar lifecycle

**PRs:** #4, #14–#18.

- [x] Create the frameless transparent strip window and separate settings window.
- [x] Add menu-bar actions: Show/Hide, Settings, Quit.
- [x] Keep the utility out of the macOS Dock during normal operation.
- [x] Implement primary-display default placement (verified by merged PR #4).
- [x] Persist the selected display, fall back to primary while absent, and restore the preference when it reconnects (PR #16; simulated topology and native restart verified, physical unplug/reconnect remains below).
- [ ] Implement Spaces/full-screen visibility without taking focus on hover. The all-workspaces/full-screen native flags and non-focusable hover path are automated; actual Space/full-screen transitions remain physically unverified.
- [ ] Implement accurate mouse passthrough. Bounded native island hit regions and transparent-region ignore mode are automated; a real click reaching an arbitrary application behind the overlay remains physically unverified.
- [ ] Handle display changes, sleep/wake, and application shutdown. Display/resume recovery, close/crash/load-failure replacement, activation, and shutdown cleanup are automated; physical sleep/wake and display reconfiguration remain unverified.
- [ ] **E2E and corrections:** test real clicks into an application behind the overlay, hover without focus theft, full-screen apps, two displays, unplug/reconnect, and wake recovery; fix, rerun, harden, and merge.

### Epic 2 — Rounded-square status tiles and Dock magnification

**PRs:** `feat/status-tiles`, `feat/dock-magnification`.

Design history: PR #31 replaced the tiles with the folded tab dock, and PR #49
(merged at `cda8ca934acad05e9b7c4baefcfcbe2c86524deb` on 2026-09-23) replaced
the dock with the compact dynamic island, and PR #53 (merged at
`43b7fc1cbedda35563d8f4f6b739ef2fb691129f` the same day) split it into the
Codex and Claude columns with a finish cue described in section 2. The checked items below record the earlier renderers; the
unchecked native baseline, passthrough, and E2E acceptance items now apply to
the island.

Implementation progress (not an acceptance checkoff): PR #8 merged into
`staging` at `1f3c523465de0cff9eb2cbafb65a04cb347ce301` from final feature head
`febe543d76a4e8d052b85c8e044bf612f471a1d3`. It implements the rounded-square
renderer, magnification, overflow and keyboard behavior, stock
tooltip/context-menu composition, and browser visual fixtures. Its 94 total
unit tests, 3 Electron smoke tests, and 22 browser fixture tests pass in [CI run
34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805).
Renderer/browser review and merge are complete. PRs #14 and #15 mount the same
renderer in the sandboxed native overlay and synchronize bounded tile, tooltip,
and context-menu hit regions. Native 0/1/12/30-session, keyboard, lifecycle,
state-restoration, and portal tests are automated. Underlying-app click-through,
native visual baseline comparison, Spaces/full-screen, and physical
multi-display acceptance remain pending; those acceptance tasks below stay
unchecked.
Formal root QA1 found and corrected the height-observer remount lifecycle,
zero/non-finite wheel delta handling, and redundant reverse packing pass. Formal
root QA2 found and removed the unused `TileGeometry.expanded` field; it found no
further issues. The final merged validation passed 94 unit tests and 25 E2E
tests (3 Electron smoke tests and 22 browser fixture tests), with [CI run
34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805).
The merged renderer is integrated with the native overlay; physical desktop
interaction and visual-baseline acceptance remain unchecked.

- [x] Implement the exact palette and rounded-square geometry at collapsed, intermediate, and expanded sizes (renderer/browser verified and mounted natively in PR #14; native visual baseline comparison remains pending).
- [x] Render provider and state icons only at expanded sizes (renderer/browser verified).
- [x] Implement stable distance-based magnification (renderer/browser verified).
- [x] Implement one-line tooltips, keyboard selection, and reduced motion (renderer/browser verified).
- [x] Implement overflow scrolling and conditional overflow indicators (renderer/browser verified).
- [x] Freeze list geometry during interaction (renderer/browser verified).
- [x] Generate browser visual fixtures/screenshots for all states, light/dark backgrounds, and 1x/2x display scales (visual evidence only; not native baseline comparison).
- [ ] Capture and compare native visual baselines for the integrated overlay.
- [x] Wire the renderer into the native overlay and synchronize bounded tile, tooltip, and context-menu hit regions (PRs #14–#15).
- [ ] Verify native passthrough and underlying-app click-through for the integrated overlay.
- [ ] **E2E and corrections:** exercise 1, 12, and 30 sessions; sweep the pointer across neighbors; verify no flicker, clipping, accidental activation, unexpected labels, or blocked desktop clicks; fix, rerun, harden, and merge.

### Epic 3 — Session state, ordering, and persistence

**PRs:** `feat/session-state`, `feat/session-persistence`.

- [x] Implement shared session types and the deterministic status reducer.
- [x] Namespace identities and deduplicate surfaces.
- [x] Implement deterministic session ordering and filtering (the recent-item visibility policy supersedes the initial active-only projection).
- [x] Persist unread state, acknowledgement IDs, ordering, and cursors atomically (merged PR #5).
- [ ] Suppress historical unread completions on first installation (persistence and reader emit baseline markers; applying them in live app replay remains pending).
- [x] Handle late events, duplicate events, overlapping input requests, and archived sessions.
- [x] Keep provider health separate from task failures.
- [x] Implement race-safe completion acknowledgement.
- [ ] **E2E and corrections:** replay working → waiting → working → unread → acknowledged through the real app; restart between transitions; inject late/duplicate events and simultaneous completion/click; fix, rerun, harden, and merge.

### Epic 4 — Codex Desktop and CLI

**PRs:** `feat/codex-observation`, `feat/codex-hook-setup`.

Implementation progress (not an acceptance checkoff): PR #6’s bounded rollout
reader and synthetic/source-derived fixtures are merged. PR #7’s read-only
catalog client is merged into `staging` at `419322edcfd277730acd0fef669c26479352c443`
from final feature head `57452a3`, with 83 unit tests, 3 Electron smoke tests,
format/lint/type/build checks, and green [CI run 34986281698](https://github.com/alxbra/agent-status-tiles/actions/runs/34986281698).
It completed one CodeRabbit pass with two valid findings fixed and two root QA
passes; see the [audit comment](https://github.com/alxbra/agent-status-tiles/pull/7#issuecomment-5682690186).
The live catalog-to-reader qualifier, Desktop/CLI surface mapping, and provider
wiring are being delivered in sequential live-monitoring slices. PR #22 adds
strict Codex Desktop qualification, a signed bundled CLI resolver, fixed-EOF
rollout replay, and native coordinator wiring. PR #23 adds the Desktop Settings
Connect/Disconnect control. PR #24 adds independent CLI monitoring with its own
Settings row, and PR #35 bundles both surfaces behind one `Codex` row.

- [x] Implement the bounded incremental Codex rollout reader (merged PR #6).
- [x] Implement the bounded read-only Codex app-server catalog client (merged PR #7; formal QA1 and QA2 complete).
- [ ] Integrate the reader with the Codex catalog and qualify live Desktop/CLI sessions (live wiring remains pending).
- [x] Retain attribution and avoid coupling to its Stream Deck runtime (verified by merged PR #6).
- [ ] Recognize both Desktop and CLI sessions.
- [x] Extract only required metadata in the bounded rollout reader (merged PR #6); catalog qualification and live surface mapping remain pending.
- [ ] Add explicit hook installation, trust status, repair, and removal.
- [ ] Preserve unrelated hooks, including the existing Stream Deck integration.
- [ ] Add version/format diagnostics and reconnection behavior.
- [x] Add synthetic/source-derived rollout fixtures plus a metadata-only installed-format check (merged PR #6).
- [ ] Record sanitized fixtures from controlled live Desktop/CLI lifecycles and validate them against observations.
- [ ] **E2E and corrections:** test a live task on both surfaces, including working, approval/question, completion, error, restart, and existing-hook coexistence; verify fixtures against observations; fix, rerun, harden, and merge.

### Epic 5 — Claude Code Desktop and CLI

**PRs:** `feat/hook-helper`, `feat/claude-observation`.

Implementation progress (not an acceptance checkoff): PR #9 merged into
`staging` at `c9905833628a533f7aadaf93ff82dfd0d8c9c94f` after completing its
unsigned arm64/x64 helper packaging implementation, review, native checks,
package checks, and CI checks. It does not install hooks, wire startup, or make
a signing/notarization claim.

Claude slices merged so far (implementation progress, not acceptance): PR #36
records allowlisted host identity in the helper journals so Desktop and
terminal sessions can be told apart without process ancestry; PR #37 adds the
helper path resolver and the owned-hook installer for the shared Claude
settings file; the observation slice adds journal discovery, the hook-event
normalizer, and the `claude:desktop` / `claude:cli` monitors registered with
the coordinator (`docs/claude-monitor.md`), verified against synthetic journals
by unit tests and a native Electron E2E (PR #38); PR #39 connects the
`Claude Code` row (hook installation, readiness health, Repair, hook removal
on disconnect); PR #41 adds the managed-settings check so hooks blocked by
an organization's policy surface as one sentence instead of a healthy row
(`docs/claude-monitor.md`, "Hooks silenced by policy"); PR #42 adds bounded
journal garbage collection (the collection section of
`docs/claude-monitor.md`): ended journals older than seven days are removed
with every archive at most every five minutes, never a journal a cohort,
cursor, or session still refers to, never through a symlink; PR #43 applies
the first live Connect's findings (sessions observed mid-turn open a turn on
their first record that proves work, tabs carry Claude's session names with
the project or repository name as fallback, no tooltip); PR #46 extends
collection to sessions killed without `SessionEnd`, removing a verified
journal that has not changed for more than thirty days once no cohort,
cursor, or session refers to it; PR #50 builds the helper for development
runs so Connect works from a checkout, and asks for `pnpm build:hook-helper --
--arch host` rather than a reinstall when it is missing there. Live Desktop and
terminal validation and navigation remain pending.

- [x] Build the native hook-helper executable (merged PR #2).
- [x] Package the native helper as unsigned arm64/x64 application resources (merged PR #9; signing and notarization remain pending).
- [x] Implement reduced local event journal writing, concurrency handling, bounded rotation, and silent malformed-input behavior in the merged native helper (PR #2).
- [x] Implement the bounded standalone hook-journal reader (merged PR #12 at `0d4b5ebfaebdca68bb57f27188fb41aec5c27d21`; replay contract, privacy projection, inode rotation, and cursor continuation are verified; coordinator wiring remains pending).
- [ ] Replay helper journals through companion app state (implemented in PR #38; live verification pending).
- [ ] Install only owned hooks into shared user settings.
- [ ] Detect local Desktop and terminal ownership.
- [ ] Normalize Claude lifecycle events into the shared state model.
- [ ] Handle resumed sessions, continued turns, tool failures, input resolution, and process termination.
- [ ] Preserve all unrelated user configuration.
- [ ] Verify operation without a user-installed Node.js or Python runtime.
- [ ] **E2E and corrections:** run local Claude Desktop and terminal sessions through all relevant states; test concurrent sessions, companion downtime, restart, malformed payloads, and uninstall; confirm hooks do not interrupt agent work; fix, rerun, harden, and merge.

### Epic 6 — Harness navigation and acknowledgement

**PRs:** `feat/session-navigation`.

- [x] Add validated Codex task navigation (PR #11 main-process primitive; live task selection remains pending).
- [x] Add Claude Desktop activation (PR #11 fixed bundle activation; live harness validation remains pending).
- [x] Resolve and activate qualified terminal apps (PR #11 fixed bundle activation; superseded on 2026-09-25, when CLI threads began opening their Desktop app and terminal activation was removed).
- [x] Return the one-time terminal selection-required result for unknown ownership (PR #11; superseded and removed on 2026-09-25 with terminal activation).
- [ ] Connect successful dispatch to completion acknowledgement. Implementation progress (not an acceptance checkoff): `feat/island-open-thread` wires island clicks through `openIslandSession` to the navigator and acknowledges a clicked completion only after dispatch; live harness validation remains pending.
- [ ] Preserve unread state on launch failure.
- [x] Prevent duplicate launches from rapid repeated clicks (PR #11 single-flight guard).
- [ ] **E2E and corrections:** verify real harness activation, exact Codex task selection, Desktop-app activation for CLI threads, missing-app errors, rapid clicks, and completion races; confirm no new agent session or prompt is created; fix, rerun, harden, and merge.

### Epic 7 — Minimal settings and setup

**PRs:** `feat/integration-settings`, `feat/desktop-preferences`.

Implementation progress (not an acceptance checkoff): PR #10 merged the
controlled Settings view using stock shadcn controls. PR #16 connected the
selected-display, launch-at-login, and reduced-motion controls to validated IPC
and native persistence/effects. Advanced paths and diagnostics remain pending; provider
startup and hook management (PRs #23, #24, #35, #39, #41) await live verification.

- [x] Implement the Settings view using stock shadcn controls (PR #10 renderer/browser verified; desktop controls integrated in PR #16).
- [ ] Add provider connect, disconnect, repair, and hook-removal flows. Implementation progress (not an acceptance checkoff): the Claude connect slice wires the `Claude Code` row to hook installation, readiness health with one sentence per issue, Repair, and hook removal on disconnect; live verification with real Desktop and terminal sessions remains pending.
- [x] Add functional display selection, launch-at-login, and reduced-motion controls with validated IPC and native persistence/effects (PR #16).
- [ ] Add advanced path overrides and reduced diagnostics export.
- [x] Show one concise actionable error sentence for controlled failures (PR #10 renderer/browser verified).
- [ ] Add required setup instructions for missing or unavailable integrations.
- [x] Remove redundant labels, descriptions, helper text, and repeated status from the presentational view (PR #10 renderer/browser verified).
- [ ] Persist changes immediately. Desktop display/reduced-motion preferences and launch-at-login effects are implemented; future provider/setup settings remain pending.
- [ ] **E2E and corrections:** complete fresh setup with both harnesses, test missing installations, permission/config errors, settings persistence, and hook removal; visually compare against the strict UI contract; fix, rerun, harden, and merge.

### Epic 8 — Reliability, privacy, and performance

**PRs:** separate bounded fixes discovered during validation.

- [ ] Test crashes, reconnects, sleep/wake, truncated event files, journal rotation, and damaged local preferences.
- [ ] Verify child processes and watchers stop cleanly.
- [ ] Confirm malformed IPC and invalid navigation targets are rejected.
- [ ] Inspect logs and exports for prompt, transcript, credential, and path leakage.
- [ ] Measure a 60-minute session with at least 20 observed tasks.
- [ ] Target under 1% average idle CPU and under 250 MB total resident memory for the companion and helper processes on the reference Mac.
- [ ] Target visible status updates within one second of receiving a local event.
- [ ] Confirm resource usage stabilizes after repeated session churn.
- [ ] **E2E and corrections:** run the complete four-surface matrix and native desktop interaction suite after fault injection; correct failures, rerun affected scenarios, harden, and merge.

### Epic 9 — Publishable macOS release candidate

**PRs:** `build/macos-release`, `docs/release-readiness`.

- [ ] Package separate Apple Silicon and Intel DMG/ZIP artifacts.
- [x] Use product name `Agent Status Tiles` and bundle ID `com.alxbra.agent-status-tiles` (verified in the merged package configuration).
- [ ] Provide an original minimal application/menu-bar icon.
- [ ] Sign the application and bundled helper; notarize and staple release artifacts.
- [ ] Make release builds fail if required signing credentials are missing.
- [ ] Add checksums and a draft GitHub release workflow.
- [ ] Document installation, supported harness versions, hook setup/removal, privacy, and known navigation limits.
- [ ] Document Windows/Linux as future platforms.
- [ ] Verify clean installation, upgrade, relaunch, login launch, and removal of owned integration settings.
- [ ] Record exact build SHA, supported macOS minimum, tested harness versions, and hardware.
- [ ] **E2E and corrections:** install the signed candidate on clean macOS test accounts, verify Gatekeeper acceptance and all four integrations, fix release-only failures, rerun, harden, and merge.

Signing and notarization require Apple Developer credentials. This remains an explicit release dependency; unsigned developer builds do not satisfy the publishable-release gate. [Signing documentation](https://www.electron.build/docs/features/code-signing/)

## 6. Completion evidence and release gate

### Per-PR record

Maintain this table in the plan:

| PR | Epic/tasks | CodeRabbit passes | QA passes | Final E2E evidence | Merge SHA |
|---|---|---:|---:|---|---|
| Bootstrap `99c7200` | Repository bootstrap and branch workflow | — | — | — | `99c72007c0380a29373be2579ef8b4e5a6b314cc` |
| [#1 `chore/app-foundation`](https://github.com/alxbra/agent-status-tiles/pull/1) | Epic 0 application foundation | 1 completed CLI pass after 1 failed transport attempt; 5 findings, 1 valid fixed, 4 rejected | 2 | 5 unit tests, 2 native Electron E2E tests, format/lint/type/build checks, and unsigned arm64 packaging; [CI run 34971932124](https://github.com/alxbra/agent-status-tiles/actions/runs/34971932124) | `4593ee4346272ac1db24510adb821b79fc1d940e` |
| [#2 `feat: add bounded native hook helper`](https://github.com/alxbra/agent-status-tiles/pull/2) | Bounded Claude hook-helper foundation | 1 completed CLI pass; 2 valid findings fixed | 2 | 11 native helper tests, 5 app unit tests, 2 Electron E2E tests, format/lint/type/build checks; [CI run 34972446167](https://github.com/alxbra/agent-status-tiles/actions/runs/34972446167), [CI run 34972446325](https://github.com/alxbra/agent-status-tiles/actions/runs/34972446325) | `b536b6c4a6246e6e31650304ea10c94b1f87963f` |
| [#3 `feat: add deterministic session state`](https://github.com/alxbra/agent-status-tiles/pull/3) | Pure session types, reducer, selectors, lifecycle, and provider-health behavior | 1 completed CLI pass; 0 findings | 2 | 18 unit tests, 2 Electron E2E tests, format/lint/type/build checks; [CI run 34973408658](https://github.com/alxbra/agent-status-tiles/actions/runs/34973408658) | `33657030eff342466aa9bb8f4ffc001bce8212d4` |
| [#4 `feat: add desktop shell and menu bar`](https://github.com/alxbra/agent-status-tiles/pull/4) | Epic 1 shell window, menu-bar lifecycle, default placement, and visibility scaffolding | 1 completed CLI pass; 1 invalid finding rejected | 2 | 23 unit tests, 3 Electron E2E tests, format/lint/type/build checks; [CI run 34978000636](https://github.com/alxbra/agent-status-tiles/actions/runs/34978000636) | `a454bf22a8c9521eeefb9db87845fd438d44e7c9` |
| [#5 `feat: add atomic session persistence`](https://github.com/alxbra/agent-status-tiles/pull/5) | Atomic persisted session state and restart-safe status refresh | 1 completed CLI pass; 0 findings | 2 | 33 unit tests, 3 Electron E2E tests, format/lint/type/build checks; [CI run 34978274333](https://github.com/alxbra/agent-status-tiles/actions/runs/34978274333) | `5deb6aeb1f6dee9a5d0ab44e038102b3efb6c6fd` |
| [#6 `feat: add bounded Codex rollout reader`](https://github.com/alxbra/agent-status-tiles/pull/6) | Codex rollout reader with bounded, causal event normalization, synthetic/source-derived fixtures, and a metadata-only installed-format check | 1 completed CLI pass; 1 valid finding fixed | 2 | 62 unit tests, 3 Electron E2E tests, format/lint/type/build checks; [CI run 34980907374](https://github.com/alxbra/agent-status-tiles/actions/runs/34980907374); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/6#issuecomment-5681842281) | `3f7fa776065ca6aaf6942c1c06dd6c7e8894ab68` |
| [#7 `feat/codex catalog`](https://github.com/alxbra/agent-status-tiles/pull/7) | Read-only Codex app-server catalog client with bounded metadata projection | 1 completed CLI pass; 2 valid findings fixed | 2 | 83 unit tests, 3 Electron smoke tests, format/lint/type/build checks; green [CI run 34986281698](https://github.com/alxbra/agent-status-tiles/actions/runs/34986281698); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/7#issuecomment-5682690186) | `419322edcfd277730acd0fef669c26479352c443` |
| [#8 `feat: add rounded-square status tile UI`](https://github.com/alxbra/agent-status-tiles/pull/8) | Isolated rounded-square tile renderer, magnification, overflow, keyboard interaction, and visual fixtures | 1 completed CLI pass; 1 valid finding fixed | 2 | 94 unit tests, 3 Electron smoke tests, 22 browser fixture tests; final head `febe543d76a4e8d052b85c8e044bf612f471a1d3`; [CI run 34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/8#issuecomment-5682973864) | `1f3c523465de0cff9eb2cbafb65a04cb347ce301` |
| [#9 `build/helper packaging`](https://github.com/alxbra/agent-status-tiles/pull/9) | Unsigned arm64/x64 packaging for the existing native hook helper | 1 completed CLI pass; 1 valid documentation finding fixed | 2 | 104 TypeScript unit tests, 11 native helper tests, 25 E2E tests (3 Electron and 22 browser), format/lint/type/build checks, and unsigned arm64/x64 resource validation; [CI run 34991704461](https://github.com/alxbra/agent-status-tiles/actions/runs/34991704461), [native run 34991704642](https://github.com/alxbra/agent-status-tiles/actions/runs/34991704642), [package run 34991704417](https://github.com/alxbra/agent-status-tiles/actions/runs/34991704417); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/9#issuecomment-5683519994) | `c9905833628a533f7aadaf93ff82dfd0d8c9c94f` |
| [#10 `feat: add presentational settings view`](https://github.com/alxbra/agent-status-tiles/pull/10) | Renderer-only stock-shadcn Settings view, controlled provider/display/preferences presentation, and browser fixture | 1 completed CLI pass; 0 findings | 2 | Final local validation at `d07b3a3`: 104 unit tests, 3 Electron smoke tests, 29 browser fixture tests, format/lint/type/build checks; [CI run 34992343659](https://github.com/alxbra/agent-status-tiles/actions/runs/34992343659); [package run 34992343684](https://github.com/alxbra/agent-status-tiles/actions/runs/34992343684); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/10#issuecomment-5683612055) | `07b399fb5d6b8b8bac696f599860a02797bd464b` |
| [#11 `feat: add application navigation`](https://github.com/alxbra/agent-status-tiles/pull/11) | Main-only macOS navigation primitive for validated Codex, Claude Desktop, qualified terminal, and unknown-owner selection results | 1 completed CLI pass; 0 findings (2 rate-limited attempts were not passes) | 2 | 121 unit tests, 32 E2E tests (3 Electron and 29 browser), format/lint/type/build checks; standalone process, target-validation, single-flight, and dispatch tests; live activation and native acceptance pending; [CI run 34997982330](https://github.com/alxbra/agent-status-tiles/actions/runs/34997982330); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/11#issuecomment-5684446594) | `8f368b6872317755039a4599a94a898048db1ac1` |
| [#12 `feat/hook-journal-reader`](https://github.com/alxbra/agent-status-tiles/pull/12) | Provider-neutral bounded hook-journal replay reader with privacy projection, inode-aware rotation, cursor continuation, and fixed diagnostics | 1 completed CLI pass; 2 findings (1 documentation fixed, 1 Windows-test-skip request rejected for the macOS-first target) | 2 | Final combined validation at `6482549`: 139 unit tests, 32 E2E tests (3 Electron and 29 browser), format/lint/type/build checks; final feature head `2f6d7d8`; [CI run 34998566345](https://github.com/alxbra/agent-status-tiles/actions/runs/34998566345); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/12#issuecomment-5684450834) | `0d4b5ebfaebdca68bb57f27188fb41aec5c27d21` |
| [#13 `docs: update MVP plan and next epic handoff`](https://github.com/alxbra/agent-status-tiles/pull/13) | Documentation-only implementation record and native-overlay handoff | 1 completed CLI pass; 0 findings | 2 | 139 unit tests, 32 E2E tests, format/lint/type/build checks; [CI run 35000784355](https://github.com/alxbra/agent-status-tiles/actions/runs/35000784355); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/13#issuecomment-5684843653) | `1c99aee8bef78db088a9c128d643977407218071` |
| [#14 `feat: mount native overlay renderer`](https://github.com/alxbra/agent-status-tiles/pull/14) | Typed native overlay bridge, sanitized state projection, renderer mount, and empty-state hiding | 1 completed CLI pass; 1 valid finding fixed | 2 | 147 unit tests, 36 E2E tests, format/lint/type/build checks; [CI run 35018045475](https://github.com/alxbra/agent-status-tiles/actions/runs/35018045475); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/14#issuecomment-5687441317) | `177935dcad9f899cb30afa012f474b0e73392fa7` |
| [#15 `feat: synchronize overlay portal hit regions`](https://github.com/alxbra/agent-status-tiles/pull/15) | Viewport-aware tile, tooltip, and context-menu hit regions with bounded native passthrough control | 1 completed CLI pass; 2 valid findings fixed | 2 | 154 unit tests, 40 E2E tests (10 Electron and 30 browser), format/lint/type/build checks; [CI run 35021089851](https://github.com/alxbra/agent-status-tiles/actions/runs/35021089851); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/15#issuecomment-5687812504) | `d063d5aa8e942f3a9b8d94296a32d4abe0c67f9b` |
| [#16 `feat: persist selected display preferences`](https://github.com/alxbra/agent-status-tiles/pull/16) | Selected-display/reduced-motion/login settings integration, persistence, fallback, and reconnect behavior | 1 completed CLI pass; 1 valid finding fixed | 2 | 170 unit tests, 41 E2E tests, format/lint/type/build checks; [CI run 35025029306](https://github.com/alxbra/agent-status-tiles/actions/runs/35025029306); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/16#issuecomment-5688279296) | `11677a5f4eafd9413ed092b64503521751b2327c` |
| [#17 `feat: add deliberate overlay keyboard mode`](https://github.com/alxbra/agent-status-tiles/pull/17) | Explicit menu-bar keyboard entry, durable renderer handshake, arrow navigation, and Escape teardown | 1 completed CLI pass; 0 findings | 2 | 181 unit tests, 43 E2E tests, format/lint/type/build checks; [CI run 35027865925](https://github.com/alxbra/agent-status-tiles/actions/runs/35027865925); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/17#issuecomment-5688603468) | `2a0c3f6d02069d6a963461aedb184d91ae13e42c` |
| [#18 `feat: recover native overlay lifecycle`](https://github.com/alxbra/agent-status-tiles/pull/18) | Display/resume/activation recovery, close/crash/load-failure replacement, bounded renderer handshakes, and listener cleanup | 1 completed CLI pass; 0 findings | 2 | 191 unit tests, 46 E2E tests, format/lint/type/build checks; [CI run 35031233902](https://github.com/alxbra/agent-status-tiles/actions/runs/35031233902); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/18#issuecomment-5688980090) | `9dc43416eb6e060ded084977717ae35a7bb2ca35` |
| [#20 `feat: partition monitoring state by provider surface`](https://github.com/alxbra/agent-status-tiles/pull/20) | Live Codex slice 1: schema v2 surface partitions, v1 record migration, independent atomic Connect/Disconnect | 1 completed CLI pass; 1 valid test finding fixed | 2 | 201 unit tests, 46 E2E tests, format/lint/type/build checks; [final CI run 35087785863](https://github.com/alxbra/agent-status-tiles/actions/runs/35087785863); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/20#issuecomment-5696368746) | `fa82f06a57cf14f3a08684acc385fb534635c734` |
| [#21 `feat: coordinate per-surface monitoring runtime`](https://github.com/alxbra/agent-status-tiles/pull/21) | Live Codex slice 2: isolated runtime baselines, bounded overlay projection, retry/lifecycle wiring | 1 completed CLI pass after 1 rate-limited attempt; 2 valid findings fixed | 2 | 216 unit tests, 47 E2E tests, format/lint/type/build checks; [final CI run 35092198563](https://github.com/alxbra/agent-status-tiles/actions/runs/35092198563); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/21#issuecomment-5696919140) | `cca2adb0a66b8290c3fabe2741bd55733d727044` |
| [#22 `feat: monitor Codex Desktop sessions`](https://github.com/alxbra/agent-status-tiles/pull/22) | Live Codex slice 3: signed bundled CLI resolution, strict Desktop catalog/rollout matching, fixed-cutoff replay, native coordinator wiring | 1 completed CLI pass; 2 valid pagination findings fixed | 2 | 235 unit tests, 48 E2E tests (including native Desktop baseline/lifecycle/restart/child cleanup), format/lint/type/build checks; [final CI run 35095217152](https://github.com/alxbra/agent-status-tiles/actions/runs/35095217152); [audit comment](https://github.com/alxbra/agent-status-tiles/pull/22#issuecomment-5697308237) | `31289719c43887d6037dd3730d30fb730956736b` |
| [#23 `feat: connect Codex Desktop from Settings`](https://github.com/alxbra/agent-status-tiles/pull/23) | Live Codex slice 4: separate Desktop/CLI/Claude rows, validated native connection IPC, confirmed surface-local history removal, lost-reader coverage, and local E2E focus safeguard | 1 completed CLI pass; 2 valid wording findings fixed | 2 (QA1 fixed actionable-error precedence and optional Disconnect handler; QA2 no findings) | 237 unit tests, 33 headless browser E2E pass with 18 focus-capable native tests intentionally skipped locally, format/lint/type/build checks; [final macOS CI run 35104190642](https://github.com/alxbra/agent-status-tiles/actions/runs/35104190642) passed all 51 E2E tests including native Electron; [audit comment](https://github.com/alxbra/agent-status-tiles/pull/23#issuecomment-5698534181) | `ed236ec2b731f2f10761a9902fa6182fad6b2fd7` |
| [#24 `feat: monitor Codex CLI sessions`](https://github.com/alxbra/agent-status-tiles/pull/24) | Live Codex slice 5: absolute-PATH CLI resolver, strict CLI catalog/rollout matching, independent concurrent surface monitoring, and surviving-owner reveal | 1 completed CLI pass; 3 valid findings fixed (catalog-child cleanup, ambiguous originator, executable-directory permissions) | 2 (QA1 fixed inherited custom-home handling; QA2 no findings) | 250 unit tests; local 33 headless E2E pass with 20 focus-capable native tests intentionally skipped; [post-review macOS CI run 35106322249](https://github.com/alxbra/agent-status-tiles/actions/runs/35106322249) passed all 53 E2E including native Electron; format/lint/type/build checks passed | `e1a4d0ec5cbd157d4c8543c47843055a8193d929` |
| [#25 `fix: keep confirmed Codex Desktop status visible`](https://github.com/alxbra/agent-status-tiles/pull/25) | Keep confirmed Desktop observations available when legacy/ambiguous catalog entries or unsupported non-structural rollout records limit coverage; read archived metadata from its separate root; use bounded catalog pages and a 2 MiB rollout line limit; baseline newly confirmed sources to a fixed cutoff | 1 completed CLI pass; 0 findings; post-review fixes were not rerun through CodeRabbit | 2 (QA1 fixed historical completion replay for a later-confirmed source; QA2 preserved validated event source IDs through historical replay) | Local read-only live coordinator probe found a ready baseline, available Desktop health, partial-coverage warning, and visible confirmed sessions. Local format/lint/type/build, 256 unit tests, and 33 headless E2E passed; 20 focus-capable native tests intentionally skipped locally. [Post-review macOS CI run 35121651504](https://github.com/alxbra/agent-status-tiles/actions/runs/35121651504) passed 256 unit and all 53 E2E tests including native Electron. | `c859329d6b34d75d07224b4d9f38a983a7d75ffa` |
| [#26 `feat: add frosted status dock and quiet healthy coverage`](https://github.com/alxbra/agent-status-tiles/pull/26) | Suppress persistent partial-coverage warnings for otherwise healthy Codex connections; add a rounded, click-through dock backdrop with native macOS vibrancy beneath unchanged tile hit regions | 1 completed CLI pass; 0 findings; post-review QA fix was not rerun through CodeRabbit | 2 (QA1 found that CSS blur alone does not establish desktop blur and added a native non-focusable backing surface; QA2 found no further issues) | Local format/lint/type/build, 259 unit tests, and 35 headless E2E passed; 20 focus-capable native tests intentionally skipped locally. [Post-review macOS CI run 35141830645](https://github.com/alxbra/agent-status-tiles/actions/runs/35141830645) passed 259 unit and all 55 E2E tests including native Electron backing-window assertions. | `9ac0b6d1ba6ec1621e7dfefcacbeaf8e17560e0c` |
| [#27 `feat: show recent threads across harnesses`](https://github.com/alxbra/agent-status-tiles/pull/27) | Canonical Codex thread IDs, separate rollout validation, bounded task titles, recent top-level items across connected harnesses, and a persistent 1–10 limit defaulting to five | 1 completed CLI pass; 2 valid findings fixed (acknowledgement contract, stable ID tie-break) | 2 (QA1 verified cross-surface ID migration and title fallback; QA2 removed an obsolete selector and duplicate path tracking) | Local format/lint/type/build, 265 unit tests, and all 55 E2E tests passed, including 20 native Electron tests; [final CI run 35145645553](https://github.com/alxbra/agent-status-tiles/actions/runs/35145645553) passed on the latest commit. | `281943e552fd5a6174a481b1b0b775411dd2120f`. |
| [#29 `fix: show Desktop threads with validated rollout originator`](https://github.com/alxbra/agent-status-tiles/pull/29) | Confirm omitted Desktop catalog originators with validated rollout metadata; keep older task metadata while bounding active replay; isolate oversized rollouts per task | 1 completed CLI pass; 1 valid finding fixed (publish healthy tasks while quarantining an unreadable source) | 2 (QA1 marked metadata-only sources unavailable; QA2 rejected unmatched oversized diagnostics) | Local format/lint/type/build and 270 unit tests passed. The new native five-tile test passed; 55 of 56 E2E passed in the full local run and the renderer-crash recovery test passed on focused retry. Live read-only coordinator probes reached ready state with 5/5 and 10/10 visible tiles. [Final CI run 35148771131](https://github.com/alxbra/agent-status-tiles/actions/runs/35148771131) passed on the latest commit. | `90c4439f463c1bf3d02439e5d63c8f6bf2af391d` |
| [#33 `perf: list only the newest live Codex threads on discovery`](https://github.com/alxbra/agent-status-tiles/pull/33) | Live Codex slice 6: one live `thread/list` page of the shared 25-record `RECENT_THREAD_DISCOVERY_WINDOW` (no archived route, no continuation), 2 s catalog cadence, authoritative-cohort pruning of every unreported session regardless of status, 4 MiB catalog protocol-line bound, documented provider-neutral `discover` contract | 1 completed CLI pass; 0 findings (on `5be3a16`; the three follow-up commits were not rerun per the single-pass rule) | 0 recorded (the root maintainer reviewed and merged in-session after the CodeRabbit pass) | Local format/lint/type/build and 273 unit tests passed; 21 of 21 native Electron E2E passed (`codex-desktop-monitor`, `codex-cli-monitor`, `runtime-coordinator`, `foundation`) on the final head `0384963`. Real-store connect probe against the bundled Codex Desktop binary: 8.39 s → 4.3–4.9 s to "Connected", app-server CPU 12.9 s → 2.5–2.9 s per 16 s with idle gaps between polls, all five visible sessions idle on a fresh profile. A per-surface `sourceKinds` filter (~3x per-call cost) and a 50-record page (1.47 MiB, over the old 1 MiB line bound) were measured and rejected. CI passed on [`5be3a16`](https://github.com/alxbra/agent-status-tiles/actions/runs/35217291780), [`240c4ae`](https://github.com/alxbra/agent-status-tiles/actions/runs/35218461268), and [`c327e97`](https://github.com/alxbra/agent-status-tiles/actions/runs/35223149649), and [final CI run 35224417133](https://github.com/alxbra/agent-status-tiles/actions/runs/35224417133) passed on the head carrying this row. | `f244bfdf6ca25214e50ed762173e429916bdc139` |
| [#35 `feat: bundle Desktop and CLI surfaces behind one provider row`](https://github.com/alxbra/agent-status-tiles/pull/35) | One Settings row per provider (`codex`, `claude`) connecting both surfaces with rollback; `MonitorPrerequisiteError` keeps a missing installation quietly `unavailable` at a 15 s retry; one-sentence rule (surface error, or every surface missing); launch-time completion of a pre-bundling checkpoint; hermetic test-mode resolvers | 1 completed CLI pass (0.7.6, free allowance); 0 findings; QA fixes were not rerun through CodeRabbit | 2 (QA1: helpers extracted to `settings-connections.ts` with unit tests, per-surface not-installed codes, sentence copy, shared labels, backoff wording; QA2: IPC bundle-connect E2E assertion, backoff doubling test, typed resolver-code sets, backoff reset on a prerequisite miss, §3.3 wording) | Local format/lint/type/build, 283 unit tests, and all 51 E2E including 20 native Electron tests pass with `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`; `pnpm dev` against the maintainer's checkpoint completed the Codex bundle with no error. [CI run 35240104776](https://github.com/alxbra/agent-status-tiles/actions/runs/35240104776) passed on `bf03ba8`; the first run failed only on a GitHub HTTP 500 while downloading Electron. [Final CI run 35241148211](https://github.com/alxbra/agent-status-tiles/actions/runs/35241148211) passed on `947dfbe`. | `e038791e72f52139cbf938a5a4ef83cd8b773d93` |
| [#36 `feat: record allowlisted host identity in hook journals`](https://github.com/alxbra/agent-status-tiles/pull/36) | Claude slice 1: helper records `host` (allowlisted `__CFBundleIdentifier`), `entrypoint` (`CLAUDE_CODE_ENTRYPOINT`, Claude records only), `is_subagent`, `session_source`, `end_reason`; reader projects and rejects them with identical allowlists; docs and version policy | 1 completed CLI pass (0.7.6, free allowance); 0 findings; QA fixes were not rerun through CodeRabbit | 2 (QA1: plain `match` host mapping, direct env reads, out-of-list source/reason tests on both sides, doc precision; QA2: provider-gated entrypoint, unbounded `agent_id` presence, hermetic test command builder, type-shape rejections, trim wording) | Local format/lint/type/build and 284 unit tests pass; no Rust toolchain locally, so `cargo fmt`/`clippy -D warnings`/native tests ran only in CI: the `hook-helper` workflow passed on `9e41817` after one earlier flake of the pre-existing 32-process concurrency test (31/32 turns; the helper fails open after a 500 ms lock wait). The `hook-helper`, packaging, and CI workflows passed on `a7f9ee0`. | `6faaad2c844922e854cc501cf9f64f7c57b3acdf` |
| [#37 `feat: add owned Claude hook installer and helper path resolver`](https://github.com/alxbra/agent-status-tiles/pull/37) | Claude slice 2: helper path resolver (packaged resource or dev build, regular owner-executable file, translocation refused) and owned-hook install/verify/remove in the shared Claude settings file with exact-shape verification, in-place key order, symlink write-through, atomic rename with a pre-rename identity check, typed errors; no wiring | 1 completed CLI pass (0.7.6, free allowance); 3 findings, all valid and fixed (exact entry shape, dangling symlink, disabled-install idempotence); later fixes were not rerun through CodeRabbit | 2 (QA1: in-place `hooks` key on removal, temp-file cleanup, `settings-changed` guard, `settings-unwritable`, fchmod mode, post-read bound, helper-path codes, tests; QA2: prototype-safe rebuilding, handle-based bounded read with snapshot from the same inode, ctime and mode in the identity check, helper-path branch tests, umask-pinned and same-length tests, narrower types) | Local format/lint/type/build and 303 unit tests pass (20 new). No E2E affected: nothing calls the modules yet. CI and packaging workflows passed on `768952c`. | `a6778ad73a37ec08e4939cfaa288708e94ebce58` |
| [#38 `feat: observe Claude sessions from hook journals`](https://github.com/alxbra/agent-status-tiles/pull/38) | Claude slice 3: bounded journal discovery with per-surface attribution and the newest-cohort contract, hook-record normalizer with per-turn request bound and supplementary notifications, `claude:desktop` / `claude:cli` monitors registered with the coordinator (baseline keeps turn events only), `maxRecords` reader paging, `docs/claude-monitor.md` | 1 completed CLI pass (0.7.6, free allowance); 0 findings; later fixes were not rerun through CodeRabbit | 2 (QA1: unavailable journals marked by base name instead of throwing, reads paged under the coordinator event cap, `read-limit` not treated as incomplete coverage, rotation retention, newest-of-4,096 stat ordering, shared discovery instance, tests; QA2: per-turn request bound so many prompts cannot overflow persistence, prompt notifications supplementary, bounded rotation retention with presence check, baseline turn-event filter against the per-replay bound, in-flight listing memo, truncated-listing coverage flag, reader `maxRecords` tests, paging test across an open request, privacy guards keyed on the temp root) | Local format/lint/type/build, 327 unit tests, and all 52 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on the final commit. CI passed on `581e292`. | `a7044a77d0f077db16743ede8c1ae45e80e60550` |
| [#39 `feat: connect Claude Code from Settings`](https://github.com/alxbra/agent-status-tiles/pull/39) | Claude slice 4: the `Claude Code` row connects (confirmation, hook install, then both partitions), disconnects (partitions, then owned-hook removal), and repairs; readiness health per surface with one actionable sentence per issue; `settings:surface-repair` channel; provider setup hooks in `settings-connections.ts` | 1 completed CLI pass (0.7.6, free allowance); 1 valid finding fixed (remove hooks when enabling fails after install); later fixes were not rerun through CodeRabbit | 2 (QA1: lazy helper resolution with translocated/unusable issues, Connect confirmation and §2.5 alignment, known-cause failure sentences in state, shared readiness read, stop clears the issue, Repair E2E against a tampered entry; QA2: action-aware sentences, one sentence per row keyed by connection, disconnect removal failure sentence, shared Settings-window helper with a 10 s deadline, doc pointer and outcome wording, readiness memo invalidated by install) | Local format/lint/type/build, 335 unit tests, and all 56 E2E (native Electron included) pass on the final commit. The `hook-helper`, packaging, and CI workflows passed on the final commit. | `a66f8052b9c6404bca52c141f4f586fd76710125` |
| [#41 `feat: report Claude hooks blocked by managed settings`](https://github.com/alxbra/agent-status-tiles/pull/41) | Claude follow-up from `docs/claude-connection-plan.md` §3.4: the readiness check reads the file-based managed settings source (`managed-settings.json` merged with its `managed-settings.d` drop-ins) and reports a seventh issue, `hooks-blocked`, with one actionable sentence when `disableAllHooks`, `allowManagedHooksOnly`, or `strictPluginOnlyCustomization` keeps user hooks from running; an MDM profile or an unparsable managed file yields no report rather than a false alarm; project-level `disableAllHooks` documented as undetectable | 1 completed CLI pass (0.7.6, free allowance, after one rate-limited attempt that ran nothing); 4 findings reported, 2 distinct: 1 valid fixed (a later `strictPluginOnlyCustomization: false` lifts a lock), 1 rejected (server-managed settings cannot be resolved locally without reading Claude's undocumented cache); later fixes were not rerun through CodeRabbit | 2 (QA1: array-after-`true` replacement, hidden-file test proof, plist stat-error coverage, shared `errorCode`/`JsonObject`, `dirname`, doc wording; QA2: merged policy stored literally so list → `true` → list and non-boolean later values never alarm, independent drop-in test cases with a positive control, null-safe `errorCode`, doc sentences, typed test table) | Local format/lint/type/build, 343 unit tests, and all 57 E2E (native Electron included; the new connect-under-policy scenario watches the row resume once the policy is lifted) pass on the final commit. CI, `Hook helper`, and packaging workflows passed on the final commit; the Rust `Hook helper` workflow failed once on the first commit (untouched crate, lock-contention flake) and passed on rerun. | `a4feaa88f1e74695960ee0fea8f2a6a95418cdd9` |
| [#43 `feat: show sessions observed mid-turn and title tabs with Claude's session names`](https://github.com/alxbra/agent-status-tiles/pull/43) | Claude live-turn fixes from the first real Connect: a session with no turn seen (persisted or in the read) opens one at its first record that proves work (tool, permission, question, elicitation, stop, or prompt notification; never idle or sign-in notifications), so sessions already mid-turn when the hooks arrive get a tab; tab titles come from Claude's per-process session registry (`ClaudeSessionNames`, two fields, `nameSource: 'derived'` placeholders ignored, newest file wins, torn reads keep the last name), falling back to the project folder name, which the helper now sets to the repository for `<repo>/.claude/worktrees/<slug>`; the tab tooltip is removed and the §2.3 / AGENTS.md contract updated | 1 completed CLI pass (0.7.6, free allowance); 0 findings; later fixes were not rerun through CodeRabbit | 2 (QA1: positive list of turn-proving records so idle and auth notifications open no phantom turn, `sawTurn` guard so a stray record after a completed turn is plain activity, registry semantics corrected to ignore derived names, worktree naming in the helper; QA2: `nameSource` coverage including newest-placeholder-versus-older-title, `startTurn()` shared by both openers, `MAX_ID_BYTES` and a stable registry listing, dead tooltip portal selectors and comments removed, helper and monitor contracts tightened, Rust unit coverage for `project_name` edge paths) | Local format/lint/type/build, 362 unit tests, and all 57 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on the merge commit `2e05f0b` (staging PRs #41 to #45 merged in). The `hook-helper`, packaging, and CI workflows passed on `2e05f0b`; the earlier head `ddcced9` received no runs because the PR conflicted with the moved `staging`. Live check on 2026-09-17: three concurrent Claude sessions each show a tab titled with the Desktop conversation title, the worktree session as `agent-status-tiles`. | `c851eabe129211653d49aafea4dd2e9220de00c3` |
| [#42 `feat: collect ended Claude hook journals past retention`](https://github.com/alxbra/agent-status-tiles/pull/42) | Claude slice 5: `ClaudeJournalCollector` sweeps `<userData>/journals/claude` after each discovery pass at most every 5 min and removes every suffix (`.jsonl.3`, `.2`, `.1`, then `.jsonl`) of a verified journal whose newest record is `SessionEnd` and whose active file is more than 7 days old; keeps cohort, cursor, and session journals, refuses any set with a symlink or non-file, re-checks the active file before each removal, never removes lock files; bounded reads and removals per sweep, counts only; discovery's verification and stat loop shared (`docs/claude-monitor.md` collection section) | 1 completed CLI pass (0.7.6, free allowance); 0 findings; later fixes were not rerun through CodeRabbit | 2 (QA1: unreadable journals get no lasting verdict, judged journals exempt from the read budget, sorted windows over an oversized directory, shared stat loop, testable retained set, sync-safe sweep, injectable bounds, honest docs on the resume window, lock files, and sessions without `SessionEnd`; QA2: removal budget counts attempts only, refused sets remembered until they change, active-file re-check before each archive, verdicts pruned to the stat window, shared suffix list, filesystem seam with a resume-race test, root-skipped chmod tests, count and trust-domain wording) | Local format/lint/type/build, 346 unit tests (10 new collector tests, 1 new monitor test), and all 56 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `0062444`; the native Claude E2E proves an 8-day-old ended journal and its archive are removed on the first pass while a linked set, its target, and live journals remain. The `hook-helper`, packaging, and CI workflows passed on every commit, including [CI run 35259259576](https://github.com/alxbra/agent-status-tiles/actions/runs/35259259576) on `0062444`; the merge commit `0e34e85` from `staging` (PRs #41 and #44) passed the same three workflows and the native Claude specs locally, including the new connect-under-policy scenario. | `8906f061019570f83babe5fc089b87fec644b403` |
| [#46 `feat: collect Claude journals abandoned without SessionEnd`](https://github.com/alxbra/agent-status-tiles/pull/46) | Claude slice 6, the follow-up recorded by #42: a verified journal whose newest record is not `SessionEnd` is removed with its archives once its active file has not changed for more than 30 days (`JOURNAL_ABANDONED_RETENTION_MS`); the retained set now derives both surfaces' cohorts from the shared discovery listing (`claudeRetainedSet`) and is re-checked before each removal, so the guard is the cohort rather than the clock and independent of monitor start order; nothing unverified is removed at any age; the ended rule, cadence, bounds, and symlink refusal are unchanged | 1 completed CLI pass (0.7.6, free allowance); 0 findings; later fixes were not rerun through CodeRabbit | 2 (QA1: startup ordering gap where one monitor's sweep read the other's empty cohort, fixed by deriving cohorts from the listing; stale comments; the hooks-record-activity argument replaced by the actual guard and wake-up story; race-window wording; tests for a verdict cached young, a refused abandoned set, and growth before removal; the E2E made a native proof of the guard with a coordinator-level test proving removal outside a full window. QA2: no defects; retained set re-checked before each removal, shared retained-set factory used by wiring and test, sorted E2E titles, strict-boundary and window wording, option comment and fixture) | Local format/lint/type/build, 365 unit tests (43 files), and all 57 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `eec235e`, which merges `staging` through #47; the native Claude E2E proves a month-silent journal still in the CLI cohort keeps its files and tile while the ended set is removed. The CI workflow passed on every commit, including [CI run 35275023692](https://github.com/alxbra/agent-status-tiles/actions/runs/35275023692) on `eec235e`; the crate and packaging workflows did not run because nothing under their paths changed. | `cb31dddcd8fc0f06295a599a4662cf9a55898570` |
| [#49 `feat: replace the tab dock with a compact dynamic island`](https://github.com/alxbra/agent-status-tiles/pull/49) | §1, §2.1–2.4, §2.6, and the final acceptance checklist, authorized by the product owner on 2026-09-23 (Epic 2 renderer): a black, notch-style island, 32 px tall, hangs from the top center of the selected display above the menu bar (360×56 window at `display.bounds` top, `status` level, `enableLargerThanScreen`); one dot by priority (orange needs input, then green done, then blue working, then white idle), a blue dot left of green while another thread works, pulsing blue dots, a bundled Fira Code label naming the provider of the most recent thread in that state, no label when idle; clicking opens the labeled thread with the completion captured at pointer-down; errors and unavailable threads read as idle until an expanded island exists; AGENTS.md UI contract rewritten; the tab dock renderer, its context menu and tooltip primitives, portal hit-region handling, tab-dock mockup, fixture, spec, and tests removed; dismiss-error IPC kept for the expanded island | 1 completed CLI pass (0.7.6, free allowance) on `9dda1c8`; 0 findings; later fixes were not rerun through CodeRabbit | 2 (QA1: hit region published from a ResizeObserver on pill and root plus `transitionend` and visibility changes instead of a timed frame loop, keyboard entry held until the pill mounts and Escape handled overlay-wide, primary-button capture cleared on an outside pointerup, keyboard activation uses the current target, `canOpen` respected, latin-only Fira Code so no `data:` font hits the CSP, dots keyed by tone, stale docs; rejected: notch placement (product decision) and the pre-existing `openSession` stub. QA2: keyboard entry counted only once focus lands and its frame cancelled, pill box-shadow instead of a shape `drop-shadow` filter under the pulsing dots, unused data attributes, double blur, redundant resize listener and needless exports removed, a real pointer-down race test, remaining tile/dock/strip wording; rejected: a native test of main's accepted regions, which needs a new test-only hook) | Local format/lint/type/build, 358 unit tests, and all 52 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `1d6c79a`; the island fixture spec also passed with `--repeat-each=2`. A native probe on a 3440×1440 display put the overlay at (1540, 0), always on top, non-focusable, on all Spaces, with Fira Code loaded; a real screen capture over the menu bar was not possible without Screen Recording permission. One earlier full run hit a 30 s timeout in `claude-connect.spec.ts` while a local `pnpm dev` ran; the spec passed 3/3 alone and in the final run. [CI run 35905212041](https://github.com/alxbra/agent-status-tiles/actions/runs/35905212041) and the packaging workflow passed on `1d6c79a`. | `cda8ca934acad05e9b7c4baefcfcbe2c86524deb` |
| [#50 `fix: build the Claude hook helper for development runs`](https://github.com/alxbra/agent-status-tiles/pull/50) | Claude connection from a development checkout: `pnpm dev` and `pnpm start` first run `build-hook-helper.mjs --arch host --if-stale --optional` (a current helper is left alone, a missing or out-of-date one is rebuilt, and a failed build only warns); without configured Cargo the script tries `PATH`, `~/.cargo/bin`, then the stable rustup toolchains, running a toolchain Cargo with its directory on `PATH`; builds replace only the selected architectures' helpers through a verified copy and rename; an unpackaged app with no helper reports `helper-not-built`, whose sentence asks for `pnpm build:hook-helper -- --arch host` instead of a reinstall | 1 completed CLI pass (0.7.6, free allowance) on `95ee467`; 2 findings (host-only command, major; a test `PATH` that could expose a real Cargo, minor), both fixed; later fixes were not rerun through CodeRabbit | 2 (QA1: host-only command, rebuild of a helper older than the Rust sources, per-architecture install by rename instead of wiping `build/hook-helper`, Node-only test `PATH`, tests for stale and wrong-architecture rebuilds, the other architecture surviving, and parse errors under `--optional`. QA2: flag renamed to `--if-stale`, a warning that says when an out-of-date helper was kept, staged `.tmp` leftovers removed so they are never packaged, README and docs; rejected: running Cargo on every dev start instead of the timestamp check) | Local format/lint/type/build, 367 unit tests, and all 52 E2E (native Electron included) pass on `3280b3b`. On the developer Mac with no `cargo` on `PATH`, the script found the rustup toolchain and built an arm64 helper, the dev pre-step rebuilt a removed helper, and it skipped a current one in about 20 ms. [CI run 35907251166](https://github.com/alxbra/agent-status-tiles/actions/runs/35907251166), the native hook-helper workflow, and the packaging workflow passed on `3280b3b`. | `0f6790e2fb04c468c6e27cb83eaa3f93b33ec0bf` |
| [#53 `feat: split the island into Codex and Claude columns with a finish cue`](https://github.com/alxbra/agent-status-tiles/pull/53) | §1, §2.1, §2.3, §2.4, §2.6, the Deferred list, and the checklist, redesigned by the product owner on 2026-09-23 (supersedes the closed #52, which ranked done threads per harness and cleared them on app switch): two mirrored, always-visible columns (`● Codex`, `Claude ●`) in equal grid cells; each dot is needs input (orange), else working (pulsing blue), else idle (white); the done state is removed, so finished, failed, and unavailable threads are idle; a live finish (a remembered thread gaining a new, unacknowledged completion; up to 256 threads remembered) plays Cuelume's `success` cue, vendored in `src/renderer/island/success-cue.ts` (MIT) because the `cuelume` package refuses to play before a user gesture, and pulses that harness green for 5 s before its current tone, ending for good once its tone changes and never over needs input; the overlay window allows audio without a gesture; clicks open the most urgent thread | 1 completed CLI pass (0.7.6, free allowance) on `17b9326`; 3 findings: 2 fixed (the §2.6 keyboard contract and accessible name, sounds in the Deferred list), 1 rejected (clearing the cue once a harness stops working, superseded by the green-for-every-finish change); later fixes were not rerun through CodeRabbit | 2 (QA1: Cuelume's user-activation gate would have silenced the never-focused overlay, fixed by vendoring the recipe with a fixture test that the three tones play; acknowledged replays no longer sound; completions remembered across list exits; layout-effect cue without flicker; centered gap; stale acknowledgement docs; weak tests. Kept as documented limits: a brand-new thread finishing before it is shown. QA2: the green ends for good once the tone changes; one pending resume and a player that never throws; the autoplay test records the AudioContext state before any evaluate, muted; tests for a restarted cue and a green that must not return; the silent turn of a pruned thread documented) | Local format/lint/type/build, 374 unit tests, and all 55 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `31e35cd`. A native probe rendered `Codex:working, Claude:needs-input` in the real overlay, and a fresh AudioContext in the never-focused overlay reported `running`. Journal analysis for the reported stuck in-progress state found none: all 34 Claude prompts that arrived without a `Stop` came while the turn was still active, and the Claude Desktop session file's `lastActivityAt` does not move during a turn, so it was not adopted as an interrupt signal. [CI run 35915430616](https://github.com/alxbra/agent-status-tiles/actions/runs/35915430616) passed on `31e35cd`. | `43b7fc1cbedda35563d8f4f6b739ef2fb691129f` |
| [#55 `feat: open a harness's thread from its island column`](https://github.com/alxbra/agent-status-tiles/pull/55) | Epic 6 wiring, asked for by the product owner on 2026-09-23: each island column is a button opening its harness's thread captured at pointer-down (needs input, else the just-finished thread while green, else the newest working thread, else the newest openable thread); main's `overlay:open-session` stub now calls `openIslandSession`, which opens only a top-level, unarchived, openable thread in the island's state through `MacOsNavigator` (Codex Desktop selects the exact thread; Claude Desktop is activated; a Claude CLI thread activates the terminal its hook journal recorded); the runtime's overlay projection sets `canOpen` from `canNavigateTo` (Codex Desktop task UUIDs, Claude Desktop, Claude CLI with a known terminal; never Codex CLI); a clicked unread completion is acknowledged only after dispatch; a successful open leaves keyboard mode without restoring the previous app; keyboard entry focuses the column most worth opening | 1 completed CLI pass (0.7.6, free allowance) on `88c3d63`; 0 findings; later fixes were not rerun through CodeRabbit | 2 (QA1: every real session reached the island with `canOpen: false`, so clicks only worked in the fixture, fixed by projecting openability; the test runtime runs the real navigator with a recording command runner and UUID Codex test sessions; lingering keyboard mode; keyboard entry on dead columns; archived and child threads refused; cached journal host; tests for projection, failure mapping, owner lookup failure, preload validation, and the focus-preserving exit. QA2: Claude CLI openable only with a known terminal through an injected `isOpenable` rule; the focus-preserving exit is a no-op outside keyboard mode so mouse clicks leave the window alone; openable idle fallback; layout-effect ref; renamed navigator; docs. Confirmed Codex Desktop IDs are catalog thread UUIDs. Rejected: removing `canOpen` from the monitor contract) | Local format/lint/type/build, 388 unit tests, and all 58 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `f4215d8`; the island fixture spec passed three times in a row after the helper waited for the width spring; the native foundation test clicks the Codex column and records the real navigator's `open -b com.openai.codex` then `open -g -b com.openai.codex codex://threads/<uuid>` without running them. [CI run 35919668602](https://github.com/alxbra/agent-status-tiles/actions/runs/35919668602) passed on `f4215d8`. Live clicks into real Codex and Claude threads remain the Epic 6 E2E gate. | `d6f94f3ba53a834008c7564de232f6662f0a9276` |
| [#57 `fix: keep Codex threads with large tool output visible`](https://github.com/alxbra/agent-status-tiles/pull/57) | Bug fix reported by the product owner on 2026-09-24 (a running Codex Desktop thread missing from the island): its 147 MB rollout held 42 lines above the 2 MiB bound (tool output, echoed `item_completed`, `compacted` history), and the first quarantined the whole rollout. `CodexRolloutReader` now classifies an oversized line by its 256-byte envelope prefix and skips activity-only records quietly; status-bearing records, `function_call`/`function_call_output`, unknown types, and unmatched prefixes still quarantine. The verdict rides in the cursor as `isDiscardingActivityOnlyLine` (persistence and coordinator validation accept it), so a skip resumes across batches and restarts while cursors without it stay conservative; §3's quarantine rule narrowed to match | 1 completed CLI pass (0.7.6, free allowance) on `858bd97`; 2 findings, both rejected (exact type matching already required a closing quote, pinned by a test; skipped lines need not emit activity, which cannot start or resume a turn) | 2 (QA1: a status-bearing oversized line spanning a batch would have been skipped silently after resume, fixed by persisting the verdict with a legacy-cursor test. QA2: confirmed the coordinator keeps whole cursors, added a persistence round-trip, clarified the resume comment) | Local format/lint/type/build, 392 unit tests, and all 58 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `4e0537a`; new tests fail on `staging`. A read-only reader probe of the real rollout finished in 20 batches with no `oversized-line`. A live probe of the built branch on an isolated profile with only Codex Desktop enabled published the thread with its active turn, and the overlay reported `Codex working` over DevTools (screen capture is not permitted from the agent shell). [CI run 35928379473](https://github.com/alxbra/agent-status-tiles/actions/runs/35928379473) passed on `4e0537a`. Remaining: an ordinary `function_call` above 2 MiB still quarantines its rollout. | `d7222def391021ea8fa40f0514c13bd698021009` |
| [#59 `feat: hide idle harnesses and let the empty island sleep`](https://github.com/alxbra/agent-status-tiles/pull/59) | §2.1–§2.4, the checklist wording, and the `AGENTS.md` UI contract, asked for by the product owner on 2026-09-25 (first of two PRs; the second makes a click open the Desktop app): a column shows only while its harness works, needs input, or shows the green cue, one active harness centered; each name takes its dot's color; the finish cue lasts 10 s (was 5 s); with sessions but no active harness, a sleeping 17 × 8 pixel cat breathes in two frames under drifting pixel z's, opens nothing, ends keyboard entry at once, and holds still under reduced motion; the unreachable idle-harness click fallback (`latestOpenable`) is removed | 1 completed CLI pass (0.7.6) on `80e61a5` after a first attempt that failed on a WebSocket connection error before reviewing; 1 valid finding fixed (the plan said 16 × 8 for the 17 × 8 sprite) | 2 (QA1: a focused column that hid left keyboard mode stuck with nothing focused, fixed by moving focus to the other column or ending keyboard mode when the island sleeps; the pill listens for the removal blur natively because React drops it during commit, and reads the exit callback through a ref so a re-render cannot cancel the repair. QA2: no further changes) | Local format/lint/type, 392 unit tests, and all 60 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `549f8a2`; the island spec covers hidden idle columns, tone-colored names including green, the 10 s cue boundary (9.9 s vs 10.1 s), the sleeper's role, hit region, no-op click, animations, and reduced motion, waking on work, keyboard entry while asleep, and focus repair. A live probe of the built branch on an isolated profile against the real Codex Desktop store (no turn running) rendered the sleeping cat, 68 px wide, with no columns. [CI run 36129976937](https://github.com/alxbra/agent-status-tiles/actions/runs/36129976937) passed on `549f8a2`. | `25086b9a5a2b1bc803679f382f91c80697af3df4` |
| [#61 `feat: open the harness's Desktop app from its island column`](https://github.com/alxbra/agent-status-tiles/pull/61) | §1, §2.4, §3.6, Epic 6, the checklist wording, the `AGENTS.md` UI contract, and `docs/navigation.md`, asked for by the product owner on 2026-09-25 (second of two PRs after #59; they chose "always the Desktop app" over separate name and dot targets): a column click opens its harness's Desktop app at the thread captured at pointer-down. A Codex Desktop thread with a task UUID still opens exactly; any other Codex thread, CLI threads included, activates Codex Desktop; every Claude thread, CLI threads included, activates Claude Desktop; terminals are never brought forward. Every shown thread is openable. Terminal owners, `selection-required`, the journal-host lookup, the journal summaries' `host` field, the coordinator's `isOpenable` seam, and `canNavigateTo` are removed; the navigator accepts only an own-keyed `codex-thread` or `application` target | 1 completed CLI pass (0.7.6) on `921dc86`; 1 valid finding (an inherited `application` could pass validation), already fixed by QA2 and pinned by the requested test | 2 (QA1: dropped the journal summaries' `host`, which only navigation read; `host` still decides the surface. QA2: the two-key count accepted a target with an inherited `kind`; validation now requires exactly the own keys) | Local format/lint/type, 390 unit tests, and all 60 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `7489ef9`; the native foundation spec clicks a Claude CLI column and records `/usr/bin/open -b com.anthropic.claudefordesktop` beside the exact Codex thread link, through the test runtime's recording command runner. A live click that switches the frontmost app was not run and stays in the Epic 6 live-validation gate. [CI run 36131829542](https://github.com/alxbra/agent-status-tiles/actions/runs/36131829542) passed on `7489ef9`. | `71b4c0170dc1f70839db38cab0947330bb2b26a6` |
| [#63 `feat: let a fawn frenchie sleep in the empty island`](https://github.com/alxbra/agent-status-tiles/pull/63) | §2.1–§2.3, the checklist wording, and the `AGENTS.md` UI contract, asked for by the product owner on 2026-09-25 (their own fawn French bulldog in place of #59's cat; fawn chosen over mono; all five concept poses in random rotation): the sleeping island shows a 12-row pixel frenchie in one of five poses (head on paws, curled up, belly up, donut bed, sploot), picked by `pickSleepingPose` each time the island falls asleep (including reappearing asleep after hiding) and never the same pose twice in a row; it breathes in two frames and shows a twitch frame (ear or paw) for the last 0.5 s of every 7.2 s; reduced motion holds its resting frame under one z; its colors in `frenchie-poses.ts` never reuse a status color; each color is one precomputed SVG path | 1 completed CLI pass (0.7.6) on `5fb08fd`; 1 valid finding (a hidden island still counted as asleep, so reappearing idle kept its pose), already fixed by QA1 | 2 (QA1: asleep requires visible sessions, with an E2E for hide-and-reappear; paths computed once per pose; shadowed `index` renamed. QA2: keyboard entry reads the same `isAsleep` flag) | Local format/lint/type, 393 unit tests (pose grids and twitch frames, no status colors, no-repeat picker covering every pose), and all 62 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `68b106e`; the island spec covers the breathe, rest, twitch, and z animations, reduced motion, twelve wake/sleep cycles plus a hide-and-reappear without a repeated pose, and a `sleepers` fixture drawing all five poses within the 24 px content height. A live probe of the built branch on an isolated profile against the real Codex Desktop store rendered the `donut-bed` pose, 72 px wide. [CI run 36161988997](https://github.com/alxbra/agent-status-tiles/actions/runs/36161988997) passed on `68b106e`. | `340571525b259266fa3c05ece0a55f3b152e4df7` |
| [#65 `fix: recognise the originator newer Codex Desktop builds write`](https://github.com/alxbra/agent-status-tiles/pull/65) | Bug fix reported by the product owner on 2026-09-25 (Codex connected but a working thread stayed idle, so only the Claude column showed): since 2026-09-24 the Codex framework inside `ChatGPT.app` (CLI 0.155.0-alpha.16.3) writes `codex_work_desktop` instead of `Codex Desktop` as a thread's originator, so every newer Desktop thread was skipped. `src/main/providers/codex/originators.ts` names both Desktop originators, and Desktop catalog qualification, the CLI's Desktop exclusion, the catalog client's source screening, and the rollout proof use it; other spellings still fail closed; §3 names both | 1 completed CLI pass (0.7.6) on `62ee7b2`; 0 findings | 2 (QA1: the native five-slot Desktop spec now carries the new originator on a catalog record and on a rollout-proof record, and fails against the old sources. QA2: no changes; every Desktop originator comparison goes through the helper) | Local format/lint/type, 394 unit tests, and all 62 E2E (native Electron included, `AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1`) pass on `8f99fcb`. A live probe of the built branch on an isolated profile against the real Codex Desktop store published the running `codex_work_desktop` thread with its active turn, and the overlay reported `Codex working`, while the `staging` app running at the same time listed no active Codex thread. [CI run 36175263999](https://github.com/alxbra/agent-status-tiles/actions/runs/36175263999) passed on `8f99fcb`. | `01b64e10aacfc83071447e4fb5094c7aebe5dc0f` |

Foundation review corrections included strict IPC sender/frame validation, same-host renderer navigation checks, supported Node engine ranges, formatter coverage, and recovery after a failed settings-window load. No signing or notarization was claimed; Apple Developer credentials remain a release dependency.

Hook helper PR #2 merged into `staging` at `b536b6c4a6246e6e31650304ea10c94b1f87963f`. Its CodeRabbit and QA corrections were partial-tail recovery, safe lock-path handling, canonical payload fields, private paths, bounded subprocess tests, and a monotonic 500 ms lock deadline. App replay, hook installation, and the full Claude epic remain incomplete; unsigned helper packaging is covered by PR #9 below.

Session-state PR #3 merged into `staging` at `33657030eff342466aa9bb8f4ffc001bce8212d4`. It completed one CodeRabbit CLI pass with zero findings and two root QA passes, including fixes for out-of-order waits, health overlays, safe identifier lookup, bounded UTF-8 fields, redundant state, and active child/archive filter coverage. The pure reducer, identity, ordering/filter, lifecycle, provider-health, and race-safe acknowledgement tasks above are verified; standalone persistence merged in PR #5, while live-app persistence replay and the cross-file baseline gate remain pending.

Desktop-shell PR #4 merged into `staging` at `a454bf22a8c9521eeefb9db87845fd438d44e7c9`. It completed one CodeRabbit CLI pass with one invalid fake-session finding rejected and two root QA passes. The frameless strip/settings windows, menu-bar actions, Dock hiding, and default placement scaffolding are verified. PRs #14–#18 subsequently added the renderer bridge, display persistence, hit regions, keyboard entry, and recovery. Physical click-through, Spaces/full-screen, multi-display, sleep/wake, and real desktop interaction acceptance remain pending.

Persistence PR #5 merged into `staging` at `5deb6aeb1f6dee9a5d0ab44e038102b3efb6c6fd`. It completed one CodeRabbit CLI pass with zero findings and two root QA passes, including canonical status refresh and queued-failure/short-read regressions. The persistence implementation is verified by 33 unit tests, 3 Electron E2E tests, format/lint/type/build checks, and [CI run 34978274333](https://github.com/alxbra/agent-status-tiles/actions/runs/34978274333). Live-app persistence replay and the cross-file baseline gate remain pending.

Codex rollout reader PR #6 merged into `staging` at `3f7fa776065ca6aaf6942c1c06dd6c7e8894ab68`; its final feature head was `dd471955`. It completed one CodeRabbit CLI pass with one valid finding fixed and two root QA passes. Corrections covered causal input timestamps, canonical IDs, ordinary `function_call` handling, missing-metadata quarantine, stale-turn correlation, and the canonical current-turn predicate. Catalog integration, live four-surface wiring, the cross-file baseline, and cross-batch output-before-request remain pending. See the [CI run 34980907374](https://github.com/alxbra/agent-status-tiles/actions/runs/34980907374) and [audit comment](https://github.com/alxbra/agent-status-tiles/pull/6#issuecomment-5681842281).

Rounded-square tile renderer PR #8 merged into `staging` at
`1f3c523465de0cff9eb2cbafb65a04cb347ce301`; its final feature head was
`febe543d76a4e8d052b85c8e044bf612f471a1d3`. It completed one CodeRabbit CLI
pass with one valid finding fixed and two root QA passes. The renderer/browser
scope is verified by 94 unit tests, 3 Electron smoke tests, 22 browser fixture
tests, and [CI run 34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805);
see the [audit comment](https://github.com/alxbra/agent-status-tiles/pull/8#issuecomment-5682973864).
Native overlay integration and bounded portal/passthrough behavior subsequently
merged in PRs #14–#15. Physical underlying-app click-through, visual-baseline,
and multi-display acceptance remain pending.

Helper packaging PR #9 merged into `staging` at
`c9905833628a533f7aadaf93ff82dfd0d8c9c94f`. It completed one CodeRabbit CLI
pass with one valid documentation finding fixed and two root QA passes (the QA1
naming cleanup and QA2 with no further findings). The implementation is
verified by 104 unit tests, 11 native helper tests, 25 E2E tests (3 Electron and
22 browser), canonical format/lint/type/build checks, and unsigned arm64/x64
resource validation; see [CI run
34991704461](https://github.com/alxbra/agent-status-tiles/actions/runs/34991704461),
[native run 34991704642](https://github.com/alxbra/agent-status-tiles/actions/runs/34991704642),
[package run 34991704417](https://github.com/alxbra/agent-status-tiles/actions/runs/34991704417),
and the [audit comment](https://github.com/alxbra/agent-status-tiles/pull/9#issuecomment-5683519994).
Signing/notarization, startup and hook installation, app coordination/replay of
the standalone journal reader, and live provider integration remain unchecked.

Settings presentation PR #10 merged into `staging` at
`07b399fb5d6b8b8bac696f599860a02797bd464b` from implementation head
`d07b3a3`. It completed exactly one CodeRabbit pass with zero findings and two
root QA passes; QA1 requested only internal naming cleanup and fixture
simplification, and QA2 found no further issues. Final post-sync local
validation has 104 unit tests, 3 Electron smoke tests, 29 browser fixture tests,
format/lint/type/build checks, and no live provider or native settings wiring;
see [CI run 34992343659](https://github.com/alxbra/agent-status-tiles/actions/runs/34992343659),
[package run 34992343684](https://github.com/alxbra/agent-status-tiles/actions/runs/34992343684),
and the [audit comment](https://github.com/alxbra/agent-status-tiles/pull/10#issuecomment-5683612055).

Application-navigation PR #11 merged into `staging` at
`8f368b6872317755039a4599a94a898048db1ac1`. It completed one CodeRabbit CLI
pass with zero findings; two earlier rate-limited attempts were not counted as
passes. It completed two root QA passes covering process ownership and cleanup,
validated Codex task-link dispatch, Claude Desktop activation, qualified
terminal activation, the unknown-owner selection-required result, and
single-flight behavior. Final validation passed 121 unit tests and 32 E2E tests
(3 Electron and 29 browser), plus format/lint/type/build checks; see [CI run
34997982330](https://github.com/alxbra/agent-status-tiles/actions/runs/34997982330)
and the [audit comment](https://github.com/alxbra/agent-status-tiles/pull/11#issuecomment-5684446594).
Live harness activation, task selection confirmation, terminal ownership
discovery, fallback UI, acknowledgement wiring, and native acceptance remain
unchecked.

Hook-journal-reader PR #12 merged into `staging` at
`0d4b5ebfaebdca68bb57f27188fb41aec5c27d21` on 2026-09-15 at 17:03:21Z; its
reviewed implementation head was `f555e4b`, final feature head was
`2f6d7d89d67d86cb60157ca042c5e1c5fcf56b09`, and final synchronized validation
commit was `6482549`. It completed exactly one CodeRabbit pass with two findings:
one documentation wrapping finding was fixed, and a Windows-test-skip request
was rejected because this is a macOS-first target with no Windows support claim
and the existing security test must remain active. Two root QA passes are
complete; QA1 made only internal naming, `Object.hasOwn`, and redundant-assignment
cleanup and QA2 found no further issues. Final combined validation at `6482549`
passed 139 unit tests, 32 E2E tests (3 Electron and 29 browser), and
format/lint/type/build checks; the final [CI run 34998566345](https://github.com/alxbra/agent-status-tiles/actions/runs/34998566345)
is green. Live journal coordination, lifecycle reduction, first-run baseline,
provider wiring, and surface acceptance remain pending; see the [PR12 final
audit record](https://github.com/alxbra/agent-status-tiles/pull/12#issuecomment-5684450834).

Native overlay batch PRs #14–#18 merged into `staging` between
`177935dcad9f899cb30afa012f474b0e73392fa7` and
`9dc43416eb6e060ded084977717ae35a7bb2ca35`. Each completed exactly one
CodeRabbit CLI pass and two root QA/refactor passes. Corrections covered bridge
startup races, canonical/bounded metadata, portal publication races, rejected
hit-region recovery, maximum-length tooltips, display-label byte bounds,
Settings load and login-item state, durable keyboard readiness and teardown,
window/renderer recovery generations, renderer crashes and failed loads, and
bounded state/readiness handshakes. Final PR #18 validation passed 191 unit
tests and 46 E2E tests, including 15 native Electron lifecycle/bridge tests.

Automated native evidence covers empty-state hiding; sanitized 1/12/30-session
projection; non-focusable visibility; keyboard entry/Escape; bounded tile and
portal regions; selected-display preference restart; close, crash, and
main-frame load-failure replacement; state restoration; resume repositioning;
activation; and clean shutdown paths. It does not prove clicks reaching an
arbitrary third-party application, focus restoration to that application,
physical dual-display unplug/reconnect or scaling, actual Spaces/full-screen
transitions, or real sleep/wake. Those physical dependencies remain unchecked.

Work boundary: the native overlay implementation epic is complete at its
automatable boundary. This plan update and linked handoff do not start live
provider coordination, promote to `main`, or start release work. Remaining
physical overlay acceptance, live integration, baseline, signing, and release
gates stay pending.

Record corrections made after review and the commit used for final validation.

### Historical merged implementation batch

- [x] PRs #1–#18 have verified merge SHAs, recorded CodeRabbit outcomes, two root QA passes, and final validation evidence in the per-PR record above. This implementation/review record is not the final physical/live/release acceptance.

### Final acceptance checklist

- [ ] All four local harness surfaces have live validation evidence.
- [ ] The compact island hangs from the top center of the selected display at 32 pixels tall, above the menu bar.
- [ ] The island shows a Codex or Claude column only while that harness is active, one dot each (needs input or working) with the name in the dot's color; working dots pulse; with no harness active, a sleeping pixel frenchie in one of five random poses shows instead.
- [ ] A finished turn plays the success cue and pulses its harness green for 10 seconds before its current tone.
- [ ] Clicking a column opens its harness's Desktop app (the exact thread in Codex Desktop), also for CLI threads; transparent space around the island does not block underlying applications.
- [ ] Settings use stock shadcn without redundant copy.
- [ ] The configured number of recent eligible items appears, including idle and acknowledged items.
- [ ] Clicks foreground the correct owning app.
- [ ] Transparent regions do not block underlying applications.
- [ ] Spaces, full-screen, display changes, and sleep/wake work.
- [ ] Unread state survives restart without false historical completions.
- [ ] Integration failures remain distinguishable from task failures.
- [ ] Hook setup preserves other tools and uninstall removes only owned entries.
- [ ] Privacy and performance checks pass.
- [x] Every implementation PR through #18 has one CodeRabbit pass, two QA passes, final E2E evidence, and a verified merge into `staging`.
- [ ] Signed and notarized macOS artifacts pass clean-install tests.
- [ ] No unresolved release-blocking findings remain.
- [ ] Draft release artifacts and documentation are ready to publish.

Do not mark a task complete when its required native test, external credential, or review step is still pending. Record the specific dependency and continue independent work.

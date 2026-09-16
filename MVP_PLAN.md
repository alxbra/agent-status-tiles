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

Each eligible top-level thread or task gets one tile. The dock shows the five most recently updated items across connected harnesses by default, configurable from one to ten. Spawned subagents remain represented by their parent.

The main interface is a vertical row of tiny colored rounded-square tiles on the right desktop edge. Hovering produces macOS Dock-style magnification. Expanded tiles display the AI lab icon and a status icon. Clicking foregrounds the owning harness and selects the specific session where supported.

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

The merged application now mounts `StatusTiles` in the sandboxed native overlay
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

Windows and Linux releases, other screen edges, manual pinning, project grouping, cloud/SSH monitoring, IDE-specific integrations, usage dashboards, dictation, task execution controls, sounds, account systems, and automatic updates.

Public release publication and promotion from `staging` to `main` are separate final release actions. This implementation ends with a tested release candidate ready to publish.

## 2. Strict UI contract

These requirements are acceptance criteria. Agents must not embellish or reinterpret them.

### 2.1 Visual references

Use the ambient color feedback and compact interaction model of [Codex Micro](https://openai.com/supply/co-lab/work-louder/).

Reuse the exact palette and status meanings from [the existing theme module](/Users/alex/Projects/codex-status-actions/src/theme.ts). Reuse applicable logic and original artwork from that Apache-2.0 project with attribution; do not copy proprietary hardware assets.

| State | Color | Expanded status icon |
|---|---|---|
| Idle / unavailable | `#F1F1ED` | Hollow circle / disconnected icon |
| Completed, unread | `#8FEA98` | Filled circle |
| Working | `#8DCEF5` | Animated rounded arc |
| Waiting for input | `#FF8A3D` | Triangle |
| Error | `#FF6B73` | Circle with X |

Use `#111315` for dark glyphs over filled status backgrounds.

Idle is visible when its item is within the recent limit. Unavailable status is distinct from idle and is used when a previously observed item can no longer be observed reliably.

### 2.2 Collapsed strip

- Default tile size: **10 × 10 CSS pixels**, with a **3 CSS pixel corner radius**.
- Tiles must remain visibly square with rounded corners, never circular or pill-shaped.
- Default tile-center spacing: **24 CSS pixels**.
- Tile column sits **12 CSS pixels from the display’s usable right edge**.
- Vertically center the strip within the display work area.
- Collapsed tiles contain color only: no logos, numbers, text, borders, or status glyphs.
- A non-interactive, translucent macOS-style blurred backdrop with rounded corners sits behind the visible tile cohort. On macOS, a separate native vibrancy surface supplies desktop blur beneath the transparent tile overlay. It must not change tile geometry or expand native hit regions; the user explicitly authorized this after PR #25.
- No permanently visible title, toolbar, legend, or settings button.
- Each tile has a **24 × 24 pixel hit target**.
- Transparent space outside interactive targets passes mouse events to applications underneath.
- If no sessions qualify, hide the strip completely. The menu-bar icon remains available.

### 2.3 Dock magnification

Use smooth, distance-based magnification:

- Hovered tile grows to **40 × 40 pixels**.
- Adjacent tiles grow progressively less.
- Tiles outside a two-slot influence radius remain 10 × 10 pixel rounded squares.
- Expanded surfaces use an **8 CSS pixel corner radius** and the existing status color. Interpolate the radius from 3 to 8 pixels during magnification while preserving the rounded-square silhouette.
- Maintain at least 6 pixels between visible surfaces.
- Expansion grows inward from the right edge and must remain inside the work area.
- The layout must not oscillate because magnification changes the pointer’s target.
- Use stable, unmagnified slot coordinates to calculate pointer influence.
- Animate expansion and collapse over approximately **160 ms**.
- Keep the right edge anchored throughout animation.
- The backdrop follows the visible tile cohort with neutral light/dark material, without labels or controls. Its empty and corner areas remain click-through.

An expanded tile shows:

- One lab icon: OpenAI or Anthropic.
- One status icon.
- Nothing else.

Fade icons in only when the tile is large enough to render them clearly. Use a single-line stock tooltip for the task title. For Codex, use a validated catalog `name`, falling back to the project folder name. The user authorized storing this bounded name locally; never derive a title from `preview`, a transcript, or a rollout payload.

Keep titles out of logs and diagnostics.

#### Interaction mockup

```text
Collapsed                         Hovering

                              ▪
                              ▣
          ▪          ╭──────────────╮
          ▪          │  lab   state │
          ▪          ╰──────────────╯
          ▪                   ▣
                              ▪
             │ desktop edge                │ desktop edge
```

The labels above explain the mockup; they must not appear inside actual tiles. Square symbols represent rounded-square tiles; implement their exact geometry using the dimensions above. Circular status glyphs may appear inside expanded tiles, but the tile surfaces themselves must remain rounded squares.

### 2.4 Ordering, overflow, and removal

- Sort eligible items by confirmed provider update or task activity, newest first, with a stable ID tie-break. Local acknowledgement and error dismissal do not change recency.
- Apply the global Recent threads limit (default five, range one to ten) across connected harnesses, including idle items.
- Freeze ordering and automatic removals while the pointer is inside the strip.
- Apply pending list changes after pointer exit.
- Bind clicks to the session ID captured on pointer-down.
- Show at most 12 collapsed slots, further limited by available display height.
- Allow scrolling through overflow while hovering.
- Show a small directional indicator only when additional sessions exist outside the viewport.
- Items outside the configured recent limit remain in local state and return when they become recent enough.
- Successful opening acknowledges the completion that was visible when clicked.
- A newer completion arriving during navigation must remain unread.
- Failed navigation must not acknowledge completion.
- Errors remain until a new turn or explicit dismissal through the tile’s context menu.
- Dismissal affects only the companion’s display, never the underlying task.

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

Connected rows replace `Connect` with a compact status and an appropriate action menu.

Advanced contains path overrides, connection repair, hook removal, and diagnostics export.

Rules:

- One concise label per setting.
- No introductory copy, cards repeating section titles, decorative badges, descriptions, or sublines.
- Show one actionable error sentence only when a connection or setting actually fails. Do not show a persistent partial-coverage warning for an otherwise healthy Codex connection.
- Use brief confirmation text when installing or removing hooks; explain the actual configuration change.
- Keep diagnostic detail behind an explicit action.
- Saving settings is immediate; no redundant Save button.

### 2.6 Accessibility and desktop behavior

- Hover must not activate the app or steal keyboard focus.
- Support keyboard entry through the menu-bar action, arrow navigation, Enter to open, and Escape to close.
- Screen-reader names include session, provider, and status.
- Keyboard focus expands the selected tile.
- Respect system reduced-motion settings; allow explicitly enabling reduced motion.
- Reduced motion disables working animation and animated magnification.
- Tooltips must remain within the selected display.
- Display disconnection moves the strip to the primary display; reconnecting restores the selected display.
- Sleep/wake must restore monitoring and placement.
- Test actual macOS window behavior; browser screenshots alone are insufficient. Electron provides the relevant workspace and mouse-passthrough controls, but their combination needs native verification. [Electron window documentation](https://www.electronjs.org/docs/latest/api/base-window)

## 3. Architecture and integration contracts

### 3.1 Application structure

Use:

- Electron main process for integrations, state, persistence, navigation, and window placement.
- React renderer for the strip and settings.
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
                             ├─ provider adapters ─ session store ─ preload ─ strip
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
- Ended items disappear when their connected adapter no longer reports them; idle and acknowledged items may remain visible while eligible.
- Ignore stale events from previous turns.
- Parent completion must not be inferred from a subagent stopping.
- Silence alone must not be interpreted as success, failure, or a stopped session.

Persist unread markers, acknowledgement IDs, ordering, settings, and event cursors atomically. First installation must not turn historical completed sessions green.

A monitoring failure belongs to integration health. Do not mark every session as failed. Previously visible sessions with uncertain state become unavailable, and the menu-bar/settings UI exposes the connection problem.

### 3.4 Codex adapter

Adapt the existing project’s catalog client, incremental event reader, reducer, and navigation approach rather than introducing a second independent implementation.

- Use local app-server queries for task metadata.
- Use observed local task events for work performed in another Codex process.
- Use explicitly installed and trusted hooks to improve approval detection.
- Include Desktop and CLI top-level threads, including user-created forks; exclude archived, ephemeral, and spawned child threads. Use the catalog thread `id` as identity and validate rollout events against the separate session ID.
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
- Terminal sessions: resolve the owning application from bounded process ancestry and available terminal identity metadata.
- Verify Terminal, Ghostty, Warp, and iTerm2 application activation.
- Select an exact terminal session only where a verified, permission-free API supports it.
- If ownership is unknown, offer a one-time terminal-app selection.
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
- Stop background animation work when the strip is hidden.

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
- [ ] Implement accurate mouse passthrough. Bounded native tile/portal regions and transparent-region ignore mode are automated; a real click reaching an arbitrary application behind the overlay remains physically unverified.
- [ ] Handle display changes, sleep/wake, and application shutdown. Display/resume recovery, close/crash/load-failure replacement, activation, and shutdown cleanup are automated; physical sleep/wake and display reconfiguration remain unverified.
- [ ] **E2E and corrections:** test real clicks into an application behind the overlay, hover without focus theft, full-screen apps, two displays, unplug/reconnect, and wake recovery; fix, rerun, harden, and merge.

### Epic 2 — Rounded-square status tiles and Dock magnification

**PRs:** `feat/status-tiles`, `feat/dock-magnification`.

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
Connect/Disconnect control. The current slice adds independent CLI monitoring
and enables its separate Settings connection.

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

- [x] Build the native hook-helper executable (merged PR #2).
- [x] Package the native helper as unsigned arm64/x64 application resources (merged PR #9; signing and notarization remain pending).
- [x] Implement reduced local event journal writing, concurrency handling, bounded rotation, and silent malformed-input behavior in the merged native helper (PR #2).
- [x] Implement the bounded standalone hook-journal reader (merged PR #12 at `0d4b5ebfaebdca68bb57f27188fb41aec5c27d21`; replay contract, privacy projection, inode rotation, and cursor continuation are verified; coordinator wiring remains pending).
- [ ] Replay helper journals through companion app state; the app reader/replay path remains pending.
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
- [x] Resolve and activate qualified terminal apps (PR #11 fixed bundle activation; ownership discovery remains pending).
- [x] Return the one-time terminal selection-required result for unknown ownership (PR #11; selection UI remains pending).
- [ ] Connect successful dispatch to completion acknowledgement.
- [ ] Preserve unread state on launch failure.
- [x] Prevent duplicate launches from rapid repeated clicks (PR #11 single-flight guard).
- [ ] **E2E and corrections:** verify real harness activation, exact Codex task selection, terminal app fallback, missing-app errors, rapid clicks, and completion races; confirm no new agent session or prompt is created; fix, rerun, harden, and merge.

### Epic 7 — Minimal settings and setup

**PRs:** `feat/integration-settings`, `feat/desktop-preferences`.

Implementation progress (not an acceptance checkoff): PR #10 merged the
controlled Settings view using stock shadcn controls. PR #16 connected the
selected-display, launch-at-login, and reduced-motion controls to validated IPC
and native persistence/effects. Provider startup, hook management, advanced
paths, and diagnostics remain pending.

- [x] Implement the Settings view using stock shadcn controls (PR #10 renderer/browser verified; desktop controls integrated in PR #16).
- [ ] Add provider connect, disconnect, repair, and hook-removal flows.
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
- [ ] Collapsed tiles are 10 × 10 pixel rounded squares with 3 pixel corner radii and contain only color.
- [ ] Tile surfaces remain rounded squares throughout magnification; no circular or pill-shaped tile surfaces appear.
- [ ] Dock magnification is stable and matches the specified geometry.
- [ ] Expanded tiles contain only lab and status icons.
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

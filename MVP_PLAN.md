# Agent Status Tiles — MVP Implementation Plan

**Document:** `MVP_PLAN.md` in the project root.  
**Document status:** Implementation in progress; repository bootstrap, the Epic 0 application foundation, session state/persistence, the bounded Codex rollout reader, the Codex catalog (PR #7), and the rounded-square tile renderer (PR #8) are merged. Unsigned helper packaging (PR #9) remains implementation-complete on an open branch awaiting review and merge. Native integration, live provider wiring, and later release gates remain pending.
**Repository:** [alxbra/agent-status-tiles](https://github.com/alxbra/agent-status-tiles)

## 1. Product and release target

Build a minimal desktop companion that shows what local AI agents are doing without requiring the user to keep their harnesses visible.

The first publishable release targets macOS and supports:

- Codex Desktop.
- Codex CLI.
- Claude Code local sessions in Claude Desktop.
- Claude Code terminal sessions.

Each top-level task or session gets one tile. Spawned subagents remain represented by their parent session.

The main interface is a vertical row of tiny colored rounded-square tiles on the right desktop edge. Hovering produces macOS Dock-style magnification. Expanded tiles display the AI lab icon and a status icon. Clicking foregrounds the owning harness and selects the specific session where supported.

### Fixed scope

- Show working, waiting, failed, and unread-completed sessions.
- Hide idle sessions and acknowledged completions.
- Use one selected display, defaulting to the primary display.
- Appear across macOS Spaces and full-screen applications.
- Use Electron, React, TypeScript, Tailwind CSS, and stock shadcn/ui.
- Keep all monitoring and persistence local.
- Deliver signed, notarized macOS installers ready for publication.
- Integrate completed work continuously through small PRs targeting `staging`.

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

Idle exists in the state model but is not normally displayed. Unavailable status is distinct from idle and is used only when a previously visible session can no longer be observed reliably.

### 2.2 Collapsed strip

- Default tile size: **10 × 10 CSS pixels**, with a **3 CSS pixel corner radius**.
- Tiles must remain visibly square with rounded corners, never circular or pill-shaped.
- Default tile-center spacing: **24 CSS pixels**.
- Tile column sits **12 CSS pixels from the display’s usable right edge**.
- Vertically center the strip within the display work area.
- Collapsed tiles contain color only: no logos, numbers, text, borders, or status glyphs.
- No visible background container in the collapsed state.
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

An expanded tile shows:

- One lab icon: OpenAI or Anthropic.
- One status icon.
- Nothing else.

Fade icons in only when the tile is large enough to render them clearly. Use a single-line stock tooltip for the session title. If no title is available, use the project folder name; append a short session ID only when necessary to distinguish duplicates.

Do not derive titles from prompt content.

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

- New turns move their session to the top.
- Progress, waiting, errors, and completion do not reorder sessions.
- Freeze ordering and automatic removals while the pointer is inside the strip.
- Apply pending list changes after pointer exit.
- Bind clicks to the session ID captured on pointer-down.
- Show at most 12 collapsed slots, further limited by available display height.
- Allow scrolling through overflow while hovering.
- Show a small directional indicator only when additional sessions exist outside the viewport.
- Do not silently discard active or waiting sessions.
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
- Show one actionable error sentence only when a problem exists.
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
  id: string; // Namespaced by provider and native session ID.
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

Persist provider-native IDs separately from display titles. Deduplicate a session visible through multiple surfaces using provider plus native session ID, and retain the most recently confirmed owning surface.

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
- Acknowledged completion → idle, then hidden.
- New turn clears prior completion acknowledgement and prior terminal errors.
- Archived sessions disappear.
- Ended idle sessions disappear; ended unread sessions remain until acknowledged.
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
- Include Desktop and CLI sessions; exclude archived, ephemeral, and child sessions.
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

The synthetic/source-derived Codex rollout fixtures under `tests/fixtures/codex/` are a real test-only source and are isolated from production data. The browser-only settings and tile fixtures on open presentation branches are not production data sources; controlled live-format capture and end-to-end app replay remain pending.

### Epic 1 — macOS overlay and menu-bar lifecycle

**PRs:** `feat/desktop-shell`, `feat/display-placement`.

- [x] Create the frameless transparent strip window and separate settings window.
- [x] Add menu-bar actions: Show/Hide, Settings, Quit.
- [x] Keep the utility out of the macOS Dock during normal operation.
- [x] Implement primary-display default placement (verified by merged PR #4).
- [ ] Persist the selected display and restore it after reconnect.
- [ ] Implement Spaces/full-screen visibility without taking focus on hover.
- [ ] Implement accurate mouse passthrough.
- [ ] Handle display changes, sleep/wake, and application shutdown.
- [ ] **E2E and corrections:** test real clicks into an application behind the overlay, hover without focus theft, full-screen apps, two displays, unplug/reconnect, and wake recovery; fix, rerun, harden, and merge.

### Epic 2 — Rounded-square status tiles and Dock magnification

**PRs:** `feat/status-tiles`, `feat/dock-magnification`.

Implementation progress (not an acceptance checkoff): PR #8 implements the
rounded-square renderer, magnification, overflow and keyboard behavior, stock
tooltip/context-menu composition, and browser visual fixtures. Its 94 total
unit tests, 3 Electron smoke tests, and 22 browser fixture tests pass at
final feature head `febe543d76a4e8d052b85c8e044bf612f471a1d3` in [CI run
34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805).
Renderer/browser review and merge are complete. Native overlay integration,
portal bounds, passthrough hit testing, underlying-app click-through,
Spaces/full-screen, and multi-display acceptance remain pending; those native
acceptance tasks below remain unchecked.
Formal root QA1 found and corrected the height-observer remount lifecycle,
zero/non-finite wheel delta handling, and redundant reverse packing pass. Formal
root QA2 found and removed the unused `TileGeometry.expanded` field; it found no
further issues. The final feature head passed 94 unit tests and 25 E2E tests
(3 Electron smoke tests and 22 browser fixture tests), with [CI run
34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805).
The merged renderer work remains scoped to browser/renderer behavior; native
overlay integration and interaction acceptance remain unchecked.

- [x] Implement the exact palette and rounded-square geometry at collapsed, intermediate, and expanded sizes (renderer/browser verified; native integration remains pending).
- [x] Render provider and state icons only at expanded sizes (renderer/browser verified).
- [x] Implement stable distance-based magnification (renderer/browser verified).
- [x] Implement one-line tooltips, keyboard selection, and reduced motion (renderer/browser verified).
- [x] Implement overflow scrolling and conditional overflow indicators (renderer/browser verified).
- [x] Freeze list geometry during interaction (renderer/browser verified).
- [x] Generate browser visual fixtures/screenshots for all states, light/dark backgrounds, and 1x/2x display scales (visual evidence only; not native baseline comparison).
- [ ] Capture and compare native visual baselines for the integrated overlay.
- [ ] Wire the renderer into the native overlay and synchronize portal bounds and hit regions.
- [ ] Verify native passthrough and underlying-app click-through for the integrated overlay.
- [ ] **E2E and corrections:** exercise 1, 12, and 30 sessions; sweep the pointer across neighbors; verify no flicker, clipping, accidental activation, unexpected labels, or blocked desktop clicks; fix, rerun, harden, and merge.

### Epic 3 — Session state, ordering, and persistence

**PRs:** `feat/session-state`, `feat/session-persistence`.

- [x] Implement shared session types and the deterministic status reducer.
- [x] Namespace identities and deduplicate surfaces.
- [x] Implement new-turn ordering and active/unread filtering.
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
wiring remain pending.

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

Implementation progress (not an acceptance checkoff): PR #9 contains the
unsigned arm64/x64 helper packaging implementation and passes its native,
package, and CI checks on the open branch; review and merge are pending. It
does not install hooks, wire startup, or make a signing/notarization claim.

- [x] Build the native hook-helper executable (merged PR #2).
- [ ] Package the helper into the application and complete packaging review/integration (PR #9 review/merge pending).
- [x] Implement reduced local event journal writing, concurrency handling, bounded rotation, and silent malformed-input behavior in the merged native helper (PR #2).
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

- [ ] Add validated Codex task navigation.
- [ ] Add Claude Desktop activation.
- [ ] Resolve and activate owning terminal apps.
- [ ] Add the one-time terminal selection fallback for unknown ownership.
- [ ] Connect successful dispatch to completion acknowledgement.
- [ ] Preserve unread state on launch failure.
- [ ] Prevent duplicate launches from rapid repeated clicks.
- [ ] **E2E and corrections:** verify real harness activation, exact Codex task selection, terminal app fallback, missing-app errors, rapid clicks, and completion races; confirm no new agent session or prompt is created; fix, rerun, harden, and merge.

### Epic 7 — Minimal settings and setup

**PRs:** `feat/integration-settings`, `feat/desktop-preferences`.

- [ ] Implement the settings mockup using stock shadcn controls.
- [ ] Add provider connect, disconnect, repair, and hook-removal flows.
- [ ] Add display selection, launch-at-login, and reduced-motion controls.
- [ ] Add advanced path overrides and reduced diagnostics export.
- [ ] Show only actionable errors and required setup instructions.
- [ ] Remove redundant labels, descriptions, helper text, and repeated status.
- [ ] Persist changes immediately.
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
| [#9 `build/helper packaging`](https://github.com/alxbra/agent-status-tiles/pull/9) | Unsigned arm64/x64 packaging for the existing native hook helper | 1 completed CLI pass; 1 valid documentation finding fixed | Pending | Implementation complete; review/merge pending. 104 TypeScript unit tests, 11 native helper tests, format/lint/type/build checks, and unsigned packaging; Electron E2E held for the staging sync | Open; no merge SHA |

Foundation review corrections included strict IPC sender/frame validation, same-host renderer navigation checks, supported Node engine ranges, formatter coverage, and recovery after a failed settings-window load. No signing or notarization was claimed; Apple Developer credentials remain a release dependency.

Hook helper PR #2 merged into `staging` at `b536b6c4a6246e6e31650304ea10c94b1f87963f`. Its CodeRabbit and QA corrections were partial-tail recovery, safe lock-path handling, canonical payload fields, private paths, bounded subprocess tests, and a monotonic 500 ms lock deadline. Helper packaging, app replay, hook installation, and the full Claude epic remain incomplete.

Session-state PR #3 merged into `staging` at `33657030eff342466aa9bb8f4ffc001bce8212d4`. It completed one CodeRabbit CLI pass with zero findings and two root QA passes, including fixes for out-of-order waits, health overlays, safe identifier lookup, bounded UTF-8 fields, redundant state, and active child/archive filter coverage. The pure reducer, identity, ordering/filter, lifecycle, provider-health, and race-safe acknowledgement tasks above are verified; persistence and real-app replay remain pending.

Desktop-shell PR #4 merged into `staging` at `a454bf22a8c9521eeefb9db87845fd438d44e7c9`. It completed one CodeRabbit CLI pass with one invalid fake-session finding rejected and two root QA passes. The frameless strip/settings windows, menu-bar actions, Dock hiding, and default placement scaffolding are verified. Selected-display persistence, native click-through, Spaces/full-screen, multi-display, sleep/wake, and real desktop interaction acceptance remain pending.

Persistence PR #5 merged into `staging` at `5deb6aeb1f6dee9a5d0ab44e038102b3efb6c6fd`. It completed one CodeRabbit CLI pass with zero findings and two root QA passes, including canonical status refresh and queued-failure/short-read regressions. The persistence implementation is verified by 33 unit tests, 3 Electron E2E tests, format/lint/type/build checks, and [CI run 34978274333](https://github.com/alxbra/agent-status-tiles/actions/runs/34978274333). Live-app persistence replay and the cross-file baseline gate remain pending.

Codex rollout reader PR #6 merged into `staging` at `3f7fa776065ca6aaf6942c1c06dd6c7e8894ab68`; its final feature head was `dd471955`. It completed one CodeRabbit CLI pass with one valid finding fixed and two root QA passes. Corrections covered causal input timestamps, canonical IDs, ordinary `function_call` handling, missing-metadata quarantine, stale-turn correlation, and the canonical current-turn predicate. Catalog integration, live four-surface wiring, the cross-file baseline, and cross-batch output-before-request remain pending. See the [CI run 34980907374](https://github.com/alxbra/agent-status-tiles/actions/runs/34980907374) and [audit comment](https://github.com/alxbra/agent-status-tiles/pull/6#issuecomment-5681842281).

Rounded-square tile renderer PR #8 merged into `staging` at
`1f3c523465de0cff9eb2cbafb65a04cb347ce301`; its final feature head was
`febe543d76a4e8d052b85c8e044bf612f471a1d3`. It completed one CodeRabbit CLI
pass with one valid finding fixed and two root QA passes. The renderer/browser
scope is verified by 94 unit tests, 3 Electron smoke tests, 22 browser fixture
tests, and [CI run 34987937805](https://github.com/alxbra/agent-status-tiles/actions/runs/34987937805);
see the [audit comment](https://github.com/alxbra/agent-status-tiles/pull/8#issuecomment-5682973864).
Native overlay integration, portal and passthrough behavior, and multi-display
acceptance remain pending.

Record corrections made after review and the commit used for final validation.

### Final acceptance checklist

- [ ] All four local harness surfaces have live validation evidence.
- [ ] Collapsed tiles are 10 × 10 pixel rounded squares with 3 pixel corner radii and contain only color.
- [ ] Tile surfaces remain rounded squares throughout magnification; no circular or pill-shaped tile surfaces appear.
- [ ] Dock magnification is stable and matches the specified geometry.
- [ ] Expanded tiles contain only lab and status icons.
- [ ] Settings use stock shadcn without redundant copy.
- [ ] Idle and acknowledged sessions disappear.
- [ ] Clicks foreground the correct owning app.
- [ ] Transparent regions do not block underlying applications.
- [ ] Spaces, full-screen, display changes, and sleep/wake work.
- [ ] Unread state survives restart without false historical completions.
- [ ] Integration failures remain distinguishable from task failures.
- [ ] Hook setup preserves other tools and uninstall removes only owned entries.
- [ ] Privacy and performance checks pass.
- [ ] Every implementation PR has one CodeRabbit pass, two QA passes, final E2E evidence, and a verified merge into `staging`.
- [ ] Signed and notarized macOS artifacts pass clean-install tests.
- [ ] No unresolved release-blocking findings remain.
- [ ] Draft release artifacts and documentation are ready to publish.

Do not mark a task complete when its required native test, external credential, or review step is still pending. Record the specific dependency and continue independent work.

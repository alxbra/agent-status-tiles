# Agent Status Tiles — MVP Implementation Plan

**Document:** `MVP_PLAN.md` in the project root.  
**Document status:** Ready for implementation handoff; tasks are not yet implemented.  
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

The repository currently has no commits or remote branches.

The only direct bootstrap is the minimum initial commit containing the plan, project instructions, README, and ignore rules. Create `main` and `staging` from that commit. All subsequent implementation uses feature branches and PRs into `staging`.

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

- [ ] Save this plan in the project root and add project instructions preserving its UI and review requirements.
- [ ] Establish `main`, `staging`, and the feature-branch workflow.
- [ ] Scaffold Electron, React, TypeScript, Vite, Tailwind, and stock shadcn.
- [ ] Add pnpm scripts for development, build, checks, tests, and packaging.
- [ ] Add CI for lint, types, unit tests, build, and Electron smoke tests.
- [ ] Configure one-pass CodeRabbit operation.
- [ ] Add a test-only fixture source isolated from production data.
- [ ] Add Apache-2.0 licensing and attribution for reused project code.
- [ ] **E2E and corrections:** launch the built Electron application, open and close settings, verify single-instance behavior, fix failures, rerun, harden, and merge.

### Epic 1 — macOS overlay and menu-bar lifecycle

**PRs:** `feat/desktop-shell`, `feat/display-placement`.

- [ ] Create the frameless transparent strip window and separate settings window.
- [ ] Add menu-bar actions: Show/Hide, Settings, Quit.
- [ ] Keep the utility out of the macOS Dock during normal operation.
- [ ] Implement primary-display default and selected-display persistence.
- [ ] Implement Spaces/full-screen visibility without taking focus on hover.
- [ ] Implement accurate mouse passthrough.
- [ ] Handle display changes, sleep/wake, and application shutdown.
- [ ] **E2E and corrections:** test real clicks into an application behind the overlay, hover without focus theft, full-screen apps, two displays, unplug/reconnect, and wake recovery; fix, rerun, harden, and merge.

### Epic 2 — Rounded-square status tiles and Dock magnification

**PRs:** `feat/status-tiles`, `feat/dock-magnification`.

- [ ] Implement the exact palette and rounded-square geometry at collapsed, intermediate, and expanded sizes.
- [ ] Render provider and state icons only at expanded sizes.
- [ ] Implement stable distance-based magnification.
- [ ] Implement one-line tooltips, keyboard selection, and reduced motion.
- [ ] Implement overflow scrolling and conditional overflow indicators.
- [ ] Freeze list geometry during interaction.
- [ ] Add visual baselines for all states, light/dark backgrounds, and display scales.
- [ ] **E2E and corrections:** exercise 1, 12, and 30 sessions; sweep the pointer across neighbors; verify no flicker, clipping, accidental activation, unexpected labels, or blocked desktop clicks; fix, rerun, harden, and merge.

### Epic 3 — Session state, ordering, and persistence

**PRs:** `feat/session-state`, `feat/session-persistence`.

- [ ] Implement shared session types and the deterministic status reducer.
- [ ] Namespace identities and deduplicate surfaces.
- [ ] Implement new-turn ordering and active/unread filtering.
- [ ] Persist unread state, acknowledgement IDs, ordering, and cursors.
- [ ] Suppress historical unread completions on first installation.
- [ ] Handle late events, duplicate events, overlapping input requests, and archived sessions.
- [ ] Keep provider health separate from task failures.
- [ ] Implement race-safe completion acknowledgement.
- [ ] **E2E and corrections:** replay working → waiting → working → unread → acknowledged through the real app; restart between transitions; inject late/duplicate events and simultaneous completion/click; fix, rerun, harden, and merge.

### Epic 4 — Codex Desktop and CLI

**PRs:** `feat/codex-observation`, `feat/codex-hook-setup`.

- [ ] Adapt the existing project’s catalog and incremental event reader.
- [ ] Retain attribution and avoid coupling to its Stream Deck runtime.
- [ ] Recognize both Desktop and CLI sessions.
- [ ] Extract only required metadata.
- [ ] Add explicit hook installation, trust status, repair, and removal.
- [ ] Preserve unrelated hooks, including the existing Stream Deck integration.
- [ ] Add version/format diagnostics and reconnection behavior.
- [ ] Record sanitized fixtures for actual supported local formats.
- [ ] **E2E and corrections:** test a live task on both surfaces, including working, approval/question, completion, error, restart, and existing-hook coexistence; verify fixtures against observations; fix, rerun, harden, and merge.

### Epic 5 — Claude Code Desktop and CLI

**PRs:** `feat/hook-helper`, `feat/claude-observation`.

- [ ] Build and package the small hook helper.
- [ ] Implement reduced local event journals, concurrency handling, rotation, and replay.
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
- [ ] Use product name `Agent Status Tiles` and bundle ID `com.alxbra.agent-status-tiles`.
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
| Pending | — | — | — | — | — |

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

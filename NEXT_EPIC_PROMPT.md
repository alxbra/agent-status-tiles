# Next epic: macOS overlay lifecycle and native renderer bridge

Paste this prompt into the next implementation task:

You are the next root agent coordinating the earliest unfinished part of Epic 1
in this repository. Start from the latest `origin/staging` and create a fresh
bounded feature worktree. Read [AGENTS.md](AGENTS.md), [MVP_PLAN.md](MVP_PLAN.md),
and this [handoff prompt](NEXT_EPIC_PROMPT.md) completely in that new
staging-based worktree before delegating. The root checkout/main may be a stale
bootstrap checkout; do not use it as the plan or source baseline. You orchestrate
architecture, review, validation, integration, and merge only. Delegate all
implementation edits to Luna xhigh subagents; do not create descendants from
those subagents, edit another worktree, or work directly on `main`/`staging`.

## Baseline and current boundary

PRs #1–#12 are merged into `staging`; PR #12 merged at
`0d4b5ebfaebdca68bb57f27188fb41aec5c27d21`. Its final feature head is
`2f6d7d89d67d86cb60157ca042c5e1c5fcf56b09`; synchronized validation commit
`6482549` passed 139 unit tests, 32 E2E tests (3 Electron and 29 browser), and
format/lint/type/build checks; CI `34998566345` is green. Standalone state,
persistence, Codex readers, the provider-neutral hook-journal reader, helper,
navigation, settings presentation, and tile renderer are reviewed/merged, but
they are not a claim of live four-surface integration.

Verify this runtime snapshot in source before designing the bridge:

- [`src/main/index.ts`](src/main/index.ts)
  currently owns the single-instance/menu-bar/settings shell, creates the
  overlay controller, and registers only version/settings IPC handlers.
- [`src/renderer/App.tsx`](src/renderer/App.tsx)
  is a placeholder Settings page, not the full settings presentation.
- [`src/renderer/overlay-main.ts`](src/renderer/overlay-main.ts)
  imports overlay CSS only; it does not mount React or `StatusTiles`.
- [`src/main/overlay-controller.ts`](src/main/overlay-controller.ts)
  already provides the transparent, non-focusable window, primary-display
  placement, all-workspaces behavior, visibility, mouse-ignore mode, and bounded
  hit-region primitives, but it receives no session snapshots.
- [`src/renderer/tiles/StatusTiles.tsx`](src/renderer/tiles/StatusTiles.tsx)
  and its geometry/interaction/theme modules are existing renderer contracts.
- [`src/shared/ipc.ts`](src/shared/ipc.ts)
  and [`src/preload/index.ts`](src/preload/index.ts)
  currently expose no overlay/session bridge. Add only the narrow, validated
  channels required by this epic.
- [`src/main/sessions/persistence.ts`](src/main/sessions/persistence.ts)
  persists session state and cursors, not desktop display preferences. Do not
  claim selected-display persistence already exists; define and validate the
  smallest real preference contract needed here.

Production with zero qualifying sessions must remain hidden. Use sanitized,
test-only synthetic `SessionSnapshot` injection to exercise the bridge and
renderer; do not wire providers, hook installation, catalog qualification,
reader replay, or live status acceptance in this epic.

## Required scope

Implement the smallest native overlay lifecycle and renderer bridge that can be
verified on macOS:

1. Mount the existing `StatusTiles` through a typed, sender/frame-validated
   preload/IPC boundary. Project only the existing allowlisted session snapshot
   fields and bounded display/control data. Keep empty production state hidden.
2. Preserve the plan’s exact tile geometry, palette, spacing, typography, stock
   shadcn controls, and interaction conventions. Do not redesign the UI or add
   placeholder callbacks that pretend provider, navigation, acknowledgement,
   setup, or release operations work.
3. Make selected-display control functional through the existing
   [`SettingsView`](src/renderer/settings/SettingsView.tsx) only as needed for
   this epic, with a narrow validated desktop-preference interface chosen and
   documented by the root. Restore by stable display identity; if that display
   is disconnected or its identity is unavailable, use the primary display as a
   deterministic fallback and recover the selection when it returns. Existing
   persistence does not cover desktop preferences. Do not add no-op provider
   callbacks or broaden session persistence into an opaque settings store.
4. Synchronize overlay bounds and renderer hit regions, including portal/menu
   content used by existing tile interactions. Validate coordinates, counts,
   dimensions, and IPC payloads before applying them. Keep the strip transparent,
   non-focusable, and mouse-passthrough outside validated hit regions.
5. Preserve hover without focus theft (`showInactive`, focusability, and
   `setIgnoreMouseEvents` behavior), while providing a deliberate keyboard entry
   path from the menu-bar action. Keyboard mode must have explicit focus/exit
   behavior and must not make ordinary hover focus the window.
6. Handle display-added/removed/metrics-changed, sleep/wake, app activation,
   window close, and shutdown/destroy without stale listeners, orphan windows,
   or duplicate controllers. Keep Spaces/full-screen visibility consistent with
   the existing macOS window contract.
7. Reuse existing reduced-motion and accessibility behavior from `StatusTiles`;
   expose only the minimal desktop control needed for this epic. Keep provider
   connect/disconnect, advanced settings, hook setup/removal, navigation
   acknowledgement, and live monitoring outside scope.

## Verification contract

Write focused unit tests for IPC schemas, sender/frame validation, display
selection/fallback, bounds and portal hit regions, empty-state hiding, ordering,
keyboard entry/exit, reduced motion, cleanup, and event races. Add native Electron
tests—not only browser fixtures—for:

- an underlying app receiving clicks through transparent regions and no focus
  theft during hover;
- 1, 12, and 30 sanitized synthetic sessions, overflow, and zero sessions hidden;
- display scaling, negative coordinates, selected-display reconnect, unplug,
  re-addition, and metrics changes;
- Spaces/full-screen visibility and sleep/wake recovery;
- shutdown, repeated show/hide, window destruction, and listener cleanup;
- keyboard entry, Escape/exit, accessibility semantics, and reduced motion.

Browser fixtures may cover renderer geometry and visual behavior, but they are not
native proof. Never include prompts, transcripts, tool bodies, credentials, raw
provider paths, or arbitrary payloads in fixtures, logs, diagnostics, or IPC.

Split the work into small PRs from the latest `staging`, with each PR independently
formatted, linted, typechecked, unit-tested, built, and covered by the relevant
Electron tests. Root owns exactly one completed `coderabbit review --agent
--base origin/staging --committed` per PR, then two formal QA passes, final E2E,
latest green CI, safe squash/merge, and plan evidence. Leave live provider wiring,
cross-file baseline acceptance, real harness lifecycle tests, signing,
notarization, main promotion, release, and any blocked acceptance checkbox
unchecked until their evidence exists. This handoff does not resume implementation
or start a later epic; finish this overlay epic, then stop before provider/live-
harness work, main promotion, or release work.

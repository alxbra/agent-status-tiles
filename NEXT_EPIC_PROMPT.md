# Next implementation boundary: live local provider coordination

Paste this prompt into a future implementation task. The native overlay epic is
complete at its automatable boundary; this handoff does not start the work.

Start from the latest `origin/staging` in a fresh feature worktree. Read
`AGENTS.md`, `MVP_PLAN.md`, and this file completely before planning. Do not use
the stale `main` checkout as the implementation baseline.

## Verified baseline

PRs #14–#18 completed the native overlay batch. PR #18 merged into `staging` at
`9dc43416eb6e060ded084977717ae35a7bb2ca35`. Its final validation passed 191
unit tests and 46 E2E tests, including 15 native Electron tests; CI
`35031233902` is green. Every implementation PR through #18 has one completed
CodeRabbit CLI pass, two root QA/refactor passes, final E2E evidence, and a
verified squash merge.

The runtime now has:

- a sandboxed, typed, sender/frame-validated overlay bridge;
- the existing `StatusTiles` renderer mounted natively with zero-session hiding;
- bounded tile, tooltip, and context-menu hit regions;
- persisted selected-display and reduced-motion preferences plus launch-at-login;
- deliberate menu-bar keyboard entry and Escape teardown;
- close, renderer-crash/load-failure, display, resume, activation, and shutdown
  recovery with bounded renderer handshakes;
- sanitized test-only native 0/1/12/30-session coverage.

This is not yet a live agent monitor. Production has no provider coordinator,
so it correctly remains hidden with no qualifying sessions. The reducer,
session persistence, Codex catalog/rollout readers, Claude hook-journal reader,
native helper, and navigation primitive are merged but still independent.

## Earliest unfinished scope

Design the smallest provider-neutral runtime coordinator that can replay
allowlisted local observations through the existing reducer and persistence
into the overlay without weakening privacy or lifecycle boundaries. Split it
into small PRs. Start with one provider/surface path only after defining the
cross-file first-run baseline that prevents historical completions from
appearing unread.

The coordinator must:

1. keep prompts, transcripts, tool bodies, credentials, and arbitrary paths out
   of state, IPC, logs, diagnostics, and fixtures;
2. preserve provider health separately from task failure;
3. reuse canonical provider/native IDs and existing causal ordering rules;
4. persist cursors and session state atomically and recover safely after restart;
5. establish the first-run cross-file baseline before emitting unread
   completion state;
6. publish only the existing bounded `OverlayState` projection;
7. stop readers and remove listeners cleanly on shutdown, sleep, configuration
   changes, and provider loss;
8. use sanitized fixtures for fault injection, then add controlled live-format
   evidence without storing private content.

Do not combine Codex and Claude live wiring into one large PR. Do not implement
new overlay visuals, provider setup UI, hook installation/removal, real
navigation acknowledgement, signing, notarization, release publication, or
promotion to `main` unless a later request explicitly authorizes that scope.

## Remaining overlay acceptance dependency

Do not retroactively check off the physical native gates without evidence. A
real macOS acceptance pass still must verify:

- clicks reaching an arbitrary application behind transparent overlay regions;
- focus remaining with and returning to that application;
- two displays, scaling, negative coordinates, unplug/reconnect, and work-area
  changes;
- actual Spaces and full-screen transitions;
- real sleep/wake recovery;
- native visual baseline comparison.

Record automated and manual evidence separately. Browser screenshots and mocked
Electron APIs do not satisfy these physical checks.

## Delivery workflow

For each bounded PR targeting `staging`, run formatting, lint, types, unit
tests, build, and relevant native/browser E2E. Run exactly one completed
`coderabbit review --agent --base origin/staging --committed`, triage every
finding, perform two separate root QA/refactor passes with fixes after each,
process review comments, rerun final E2E, wait for green CI, squash-merge safely,
delete only the feature branch, and update `MVP_PLAN.md` with exact evidence.

Stop after the explicitly requested provider slice. Leave every unverified
live-surface, physical-overlay, signing, release, and publication checkbox
unchecked.

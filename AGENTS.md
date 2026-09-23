# Project instructions

## Source of truth

Read `MVP_PLAN.md` before changing the project. It defines the MVP scope,
architecture, privacy boundaries, native macOS requirements, acceptance
criteria, and completion evidence. Preserve the plan's unchecked task state
until the implementation and its required verification are genuinely complete.
Do not add application scaffolding as part of the repository bootstrap.

## UI contract

The overlay has a strict visual contract; it is not a redesign invitation.
Keep the exact status palette and meanings in `MVP_PLAN.md`. The user replaced
the document-tab dock with a compact dynamic island on 2026-09-23 and split
it into one column per harness the same day; the reference states render from
`tests/fixtures/dynamic-island.html`. In particular:

- The island is one black, notch-style shape hanging from the top edge of the
  selected display, centered horizontally over the menu bar: **32 px tall**, a
  flat top with **8 px** concave shoulders, a fully rounded bottom, at least
  **48 px** wide, and **14 px** of horizontal padding around its content.
- The island always shows two mirrored columns: Codex on the left (dot, then
  `Codex`) and Claude on the right (`Claude`, then dot), 28 px apart around
  the center. Each **8 px** dot shows its harness's most important thread:
  orange when one needs input, else pulsing blue while one works, else white
  for idle. There is no done state: a finished, failed, or unavailable thread
  is idle. Nothing else: no labels, icons, titles, counts, or badges.
- When a turn finishes, the island plays Cuelume's `success` cue. If that
  harness still has another thread working, its dot pulses green for
  **5 seconds** and then returns to its real tone; a harness that went idle
  simply turns white.
- Both names use bundled Fira Code at weight 500 and 12 px in one gray.
- Width follows the content with one **420 ms** spring transition. Reduced
  motion stops the pulse and every transition, but not the sound.
- Clicking the island opens the most urgent thread (waiting for input, else
  the newest working one) captured at pointer-down; an idle island does
  nothing. The island surface is the only native hit region.
- The island does not expand yet. Do not add an expanded view without explicit
  product authorization.
- Settings use stock shadcn/ui components and standard styling. Keep one
  concise label per setting and omit redundant descriptions, cards, badges,
  sublines, and Save buttons. Add only actionable error text when needed.
- Settings show one row per provider (`Codex`, `Claude Code`). A row connects
  that provider's Desktop and CLI surfaces together; the surfaces keep
  separate partitions, baselines, and health underneath. A surface whose
  installation is absent stays quietly unavailable behind a connected row and
  produces no error sentence while another surface of that provider works.

Do not change the established theme, spacing, typography, radii, controls, or
interaction model without explicit product authorization.

## Branches and pull requests

The bootstrap commit establishes `main` and `staging` at the same revision.
After bootstrap:

1. Branch from the latest `staging` and make one bounded behavior change with
   its tests.
2. Push the feature branch and open a pull request targeting `staging`.
3. Run **exactly one completed CodeRabbit CLI pass** against committed changes
   relative to `staging`:

   ```sh
   coderabbit review --agent --base origin/staging --committed
   ```

   Automatic CodeRabbit reviews are disabled in `.coderabbit.yaml`; do not
   substitute an automatic review or claim a pass that did not complete.
4. Triage every CodeRabbit finding, fix valid issues, and record rejected
   findings when applicable.
5. Run two root-owned QA/refactor reviews against the current PR diff. Fix
   valid findings after each pass and validate the fixes.
6. Run the final relevant E2E tests against the resulting implementation and
   correct failures before rerunning affected tests. Browser screenshots alone
   do not satisfy native macOS verification.
7. Wait for required checks on the latest commit, then let the root maintainer
   squash-merge the PR into `staging` and delete only the feature branch.
8. Update `MVP_PLAN.md` with the PR, merge SHA, review counts, test/E2E
   evidence, corrections, and remaining dependencies.

Do not push directly to `main` or `staging`, rewrite either branch, or make
changes there outside normal, verified PR merges after bootstrap. Do not open a
PR into `main` during MVP development. The root maintainer owns review,
integration, merge, and release-promotion decisions.

## Engineering boundaries

Keep monitoring and persistence local. Preserve context isolation, renderer
sandboxing, validated IPC, bounded filesystem/process access, and the plan's
privacy guarantees. Do not store or transmit prompts, transcripts, credentials,
or unnecessary paths. Keep provider health distinct from task failures, and do
not infer completion from silence or a child session stopping.

Every implementation PR must include proportionate checks (format, lint, types,
unit tests, build, and relevant Playwright Electron/native E2E tests) and must
leave the working tree and evidence understandable to the next contributor.

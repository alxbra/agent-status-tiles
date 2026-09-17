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
the rounded-square tile strip with a document-tab dock on 2026-09-17; the
approved mockup lives in `docs/mockups/tab-dock.html`. In particular:

- Each session is one document-style tab anchored to the usable right edge:
  **28 px tall**, **4 px apart**, an **8 px radius** on the left corners only,
  filled with the status color, and stacked with its center on the work
  area's upper-third line.
- Folded tabs show only a **12 px** colored sliver with a 24 px wide native
  hit target. A pointer within 48 px of the edge slides every tab out to
  **34 px** so the lab icon shows; hovering or focusing one tab slides it fully
  out. The slide is one transform transition of **140 ms** with an ease-out
  curve and an 8 ms per-tab stagger; the hovered tab never waits.
- While a tab is extended, a reach zone as deep as the widest tab and
  reaching 24 px above and below the stack keeps the dock open. The
  pointer's row selects the extended tab, and the margins belong to the
  edge tabs, so the pointer can travel up and down between tabs and one
  tab is always extended until the zone is left. Clicks land on tab surfaces only; the
  reach zone is never a native hit region.
- A tab contains, in order, one lab icon (OpenAI or Anthropic), the session
  title, and one lucide status icon. Nothing else: no legends, badges, or
  decorative copy. Titles truncate at 220 px with an ellipsis and no tooltip;
  the full title stays in the accessible name.
- No frosted backdrop or native vibrancy window sits behind the tabs.
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

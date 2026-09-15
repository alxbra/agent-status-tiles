# Project instructions

## Source of truth

Read `MVP_PLAN.md` before changing the project. It defines the MVP scope,
architecture, privacy boundaries, native macOS requirements, acceptance
criteria, and completion evidence. Preserve the plan's unchecked task state
until the implementation and its required verification are genuinely complete.
Do not add application scaffolding as part of the repository bootstrap.

## UI contract

The overlay has a strict visual contract; it is not a redesign invitation.
Keep the exact status palette and meanings in `MVP_PLAN.md`. In particular:

- Collapsed tiles are visibly square rounded squares sized **10 × 10 CSS px**
  with a **3 px radius**, 24 px center spacing, and 12 px from the usable right
  edge. They contain color only and have a 24 × 24 px hit target.
- Dock magnification is calculated from stable, unmagnified slot coordinates.
  The hovered tile reaches 40 × 40 px, expanded corners reach an 8 px radius,
  the right edge stays anchored, and visible surfaces keep at least 6 px between
  them. Tiles remain rounded squares throughout; never turn them into circles
  or pills.
- Expanded tiles contain only one provider/lab icon and one status icon. Use a
  single-line stock tooltip for the session title; do not add permanent labels,
  legends, decorative copy, or prompt-derived titles.
- Settings use stock shadcn/ui components and standard styling. Keep one
  concise label per setting and omit redundant descriptions, cards, badges,
  sublines, and Save buttons. Add only actionable error text when needed.

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

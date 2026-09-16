# Agent Status Tiles

Agent Status Tiles is a local macOS companion for seeing what Codex and Claude
Code sessions are doing without keeping their harness windows visible.

The product and implementation contract lives in [MVP_PLAN.md](MVP_PLAN.md).
The plan is the source of truth for scope, privacy, native macOS behavior, and
the exact overlay geometry. The current desktop shell provides secure Settings,
a hidden-until-needed transparent overlay window, and a native menu-bar entry;
provider integrations and tile rendering remain subsequent bounded PRs.

## Development workflow

- Create a feature branch from the latest `staging` branch.
- Keep each pull request focused and target `staging`.
- Complete the repository checks, one CodeRabbit CLI review, two QA/refactor
  reviews, and the required native/E2E verification before merge.
- Merge into `staging` only after all review and test evidence is recorded in
  `MVP_PLAN.md`.

`main` is reserved for the eventual release promotion. See `AGENTS.md` for the
full contribution and review requirements.

## Development commands

Use a supported Node.js line (`^20.19.0`, `^22.13.0`, or `>=24.0.0`; CI uses
Node.js 24), then install dependencies with `pnpm install`. Use `pnpm dev` for
the Electron development shell. The foundation checks are `pnpm format:check`,
`pnpm lint`, `pnpm typecheck`, and `pnpm test`. Run `pnpm test:e2e` to build and
exercise the packaged Electron entry point with an isolated temporary
user-data directory. Local runs skip native Electron tests because their windows
can take focus; browser fixture tests still run headlessly. Native tests run in
GitHub Actions, or locally only with explicit
`AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1 pnpm test:e2e`. `pnpm run pack` creates an
unsigned unpacked application under `release/`.

# Agent Status Tiles

Agent Status Tiles is a local macOS companion for seeing what Codex and Claude
Code sessions are doing without keeping their harness windows visible.

The product and implementation contract lives in [MVP_PLAN.md](MVP_PLAN.md).
The plan is the source of truth for scope, privacy, native macOS behavior, and
the exact overlay geometry. The desktop shell provides secure Settings, a
compact dynamic island at the top center of the selected display, and a native
menu-bar entry; live provider validation remains pending.

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
the Electron development shell; it first builds the Claude Code hook helper for
this Mac when the checkout has none (Rust with the matching macOS target), and
only warns if that fails. The foundation checks are `pnpm format:check`,
`pnpm lint`, `pnpm typecheck`, and `pnpm test`. `pnpm test:e2e` builds the app
and runs headless browser fixtures locally. It skips native Electron tests by
default because their windows can take focus; a local pass is not native E2E
evidence. GitHub Actions runs the native tests against the built Electron entry
point with an isolated temporary user-data directory. To run them locally,
explicitly opt in with
`AGENT_STATUS_TILES_ALLOW_FOCUS_E2E=1 pnpm test:e2e`. `pnpm run pack` creates an
unsigned unpacked application under `release/`.

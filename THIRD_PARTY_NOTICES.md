# Third-party notices

The foundation currently contains no copied third-party source code or
artwork.

The implementation plan identifies
[`codex-status-actions`](https://github.com/alxbra/codex-status-actions) as an
Apache-2.0 reference for future Codex observation work. Any source code or
original artwork reused from that project must retain its license and
attribution notices. Proprietary hardware assets are not permitted.

The bounded Codex rollout reader adapts the file-identity, byte-cursor,
chunked JSONL, replacement/truncation, partial-line, and oversized-line
handling patterns from `src/codex/rollout-watcher.ts` in that project. The
adapted work remains Apache-2.0 licensed; the root `LICENSE` contains the
license text. Stream Deck integration, process execution, and legacy aliases
were not copied.

The macOS navigation adapter also adapts the validated Codex task-link and
`/usr/bin/open` dispatch boundary from
[`src/platform/macos/task-navigator.ts`](https://github.com/alxbra/codex-status-actions/blob/main/src/platform/macos/task-navigator.ts)
and [`src/task-link.ts`](https://github.com/alxbra/codex-status-actions/blob/main/src/task-link.ts).
The adapter is Apache-2.0 licensed; it does not carry over Stream Deck actions,
shell execution, or unsupported legacy navigation modes.

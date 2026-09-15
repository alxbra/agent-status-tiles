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

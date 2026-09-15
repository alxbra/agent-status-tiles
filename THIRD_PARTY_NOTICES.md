# Third-party notices

The tile renderer uses the OpenAI and Anthropic marks from the SVG Logos icon
set (`@iconify-json/logos`, CC0-1.0), authored by Gil Barbara and distributed
at <https://github.com/gilbarbara/logos>. The paths are vendored in
`src/renderer/tiles/icons.tsx` so the renderer does not load a 7 MB icon
catalog at runtime.

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

# Third-party notices

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

The Codex catalog adapter reuses protocol and process-lifecycle concepts from
[`codex-status-actions`](https://github.com/alxbra/codex-status-actions), which
is licensed under Apache-2.0. No Stream Deck runtime, UI code, or raw provider
payload handling is copied into this repository.

The macOS navigation adapter also adapts the validated Codex task-link and
`/usr/bin/open` dispatch boundary from
[`src/platform/macos/task-navigator.ts`](https://github.com/alxbra/codex-status-actions/blob/main/src/platform/macos/task-navigator.ts)
and [`src/task-link.ts`](https://github.com/alxbra/codex-status-actions/blob/main/src/task-link.ts).
The adapter is Apache-2.0 licensed; it does not carry over Stream Deck actions,
shell execution, or unsupported legacy navigation modes.

The dynamic island bundles the Fira Code typeface (weight 500)
through `@fontsource/fira-code`. Fira Code is © The Fira Code Project Authors
and licensed under the SIL Open Font License 1.1
(<https://openfontlicense.org>); the font files are served locally and never
fetched at runtime.

`src/renderer/island/success-cue.ts` adapts the `success` recipe and the
Web Audio rendering it needs from Cuelume 0.2.2 (<https://cuelume.dev/>),
distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Daniel Belyi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

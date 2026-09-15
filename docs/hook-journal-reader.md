# Hook journal reader contract

`HookJournalReader` is a main-process, read-only replay boundary for the
private journals written by `hook-helper`. The coordinator supplies an explicit
list of already-qualified `(provider, nativeSessionId, baseName)` targets. The
reader never scans a home directory, discovers sessions, installs hooks, or
maps raw hook records to session status.

The reader opens only the target's `<baseName>.jsonl.3`, `.2`, `.1`, and active
`.jsonl` files under the caller-supplied app-data directory. It accepts regular
files only, rejects symlinks and escaping paths, and revalidates the
path-to-inode mapping after opening the bounded snapshot. A moving journal is retried
three times; persistent instability returns `source-unstable` and no cursor
advance.

Each returned event is a reduced allowlist projection of helper schema version 1.
It contains lifecycle identity, bounded correlation IDs, receipt timestamp,
   approved project metadata, approved notification/tool names, and
   `stopHookActive` when present. Unknown keys, prompts, answers, transcript/tool
   bodies, credentials, and raw paths are never returned. `Stop` remains a raw
   candidate; completion and failure policy belong to the later coordinator.

`FileCursorMap` keys remain provider-scoped relative source IDs. Journal
cursors identify the file by device/inode and byte offset, preserving the
shared baseline watermark and oversized-line continuation flag. Rotation follows
the inode across archive renames. If a prior inode is absent, the reader emits
`possible-retention-gap`: this is deliberately conservative because the cursor
alone cannot prove whether unread bytes were lost. Missing files on a first read
are not reported as a gap.

Every call is bounded: at most 128 targets, 512 input/output cursors, 8 MiB of
actual file reads, 256 KiB per file, 4 KiB per JSONL record, 4,096 projected
records, 128 diagnostics, and 16 KiB per read operation. When the byte or
record budget pauses work with unread complete records remaining, the result
includes `nextTargetIndex`; callers pass that index back as `startTargetIndex`
with the returned cursors. A full cursor map produces `cursor-limit` for a new
source without consuming it. An unterminated active tail at EOF is checkpointed
but does not request an immediate retry, so other targets are still covered;
the next ordinary poll revisits it. Archived files are immutable after helper
rotation, so an unterminated archived tail is diagnosed and dropped while
newer retained files continue. A record limit that stops before the file's
unread complete records does request continuation. Persistent snapshot
instability or a read failure likewise reports a fixed diagnostic without
creating a busy continuation loop.

This module does not provide cross-file first-run baseline initialization,
watchers, cursor persistence, lifecycle reduction, Claude turn/status mapping,
navigation, or app wiring. The coordinator owns atomic persistence of the
returned event batch and cursors.

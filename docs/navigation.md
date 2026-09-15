# macOS navigation contract

The main process accepts only catalog-qualified targets. A successful result
means that `/usr/bin/open` accepted the fixed argument array; it does not claim
that a window became frontmost or that a particular session was visibly
selected.

Codex Desktop is the only session-level action. The adapter first activates
bundle `com.openai.codex`, waits 175 ms, and dispatches
`codex://threads/<UUID>` with the same validated bundle ID selected via
`open -b`. The native session ID must be a UUID with a valid version and
variant. If either step fails, the result identifies the failed stage and no
duplicate session or fallback command is attempted.

Claude Desktop and known terminal applications receive application activation
only. Claude has no invented existing-session deep link. Terminal ownership is
qualified upstream; an unknown terminal owner returns `selection-required`
with these fixed choices: Terminal, Ghostty, Warp, or iTerm2. The adapter never
uses process ancestry, Accessibility, Automation, AppleScript, shell commands,
or commands that create/resume an agent session.

## Bundle identifier provenance

These identifiers are constants, not renderer-controlled input. On 2026-09-15,
the installed applications were checked read-only from their `Contents/Info.plist`
metadata with `defaults read`:

| Application    | Bundle identifier                | Evidence                                                                                                                                                        |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex Desktop  | `com.openai.codex`               | `/Applications/ChatGPT.app` Info.plist                                                                                                                          |
| Claude Desktop | `com.anthropic.claudefordesktop` | `/Applications/Claude.app` Info.plist                                                                                                                           |
| Ghostty        | `com.mitchellh.ghostty`          | `/Applications/Ghostty.app` Info.plist; [Ghostty documentation](https://ghostty.org/docs/config/reference)                                                      |
| Warp           | `dev.warp.Warp-Stable`           | `/Applications/Warp.app` Info.plist; [Warp documentation](https://docs.warp.dev/support-and-community/troubleshooting-and-support/logging-out-and-uninstalling) |
| Terminal       | `com.apple.Terminal`             | `/System/Applications/Utilities/Terminal.app` Info.plist                                                                                                        |
| iTerm2         | `com.googlecode.iterm2`          | [iTerm2 Python API documentation](https://iterm2.com/python-api/tutorial/running.html)                                                                          |

iTerm2 was not installed on the verification machine, so its application
activation remains a fixed-identifier integration gate rather than a live
activation claim. Bundle absence and `/usr/bin/open` failures are returned as
typed failures without guessing another owner.

Process execution has a 2-second per-command timeout and retains at most 8 KiB
of combined output internally. One navigation runs at a time; a concurrent
request is a typed `busy` failure. If a timed-out or errored child does not
emit `close` within the bounded termination grace period, the result is the
explicit `cleanup-unconfirmed` failure and the runner retains ownership and
refuses to spawn another child until that close is observed. No process output
is returned in navigation results.

# macOS navigation contract

The main process accepts only two target kinds: a Codex Desktop thread
(`{ kind: 'codex-thread', nativeSessionId }`) or a Desktop application
(`{ kind: 'application', application: 'codex-desktop' | 'claude-desktop' }`).
Anything else, including extra fields, is an `invalid-target` failure before
any command runs. A successful result means that `/usr/bin/open` accepted the
fixed argument array; it does not claim that a window became frontmost or that
a particular session was visibly selected.

Codex Desktop is the only session-level action. The adapter first activates
bundle `com.openai.codex`, waits 175 ms, and dispatches
`codex://threads/<UUID>` with the same validated bundle ID selected via
`open -b`. The native session ID must be a UUID with a valid version and
variant. If either step fails, the result identifies the failed stage and no
duplicate session or fallback command is attempted.

An application target receives activation only (`open -b <bundle>`). Claude has
no invented existing-session deep link. Terminals are never activated: since
2026-09-25 a CLI thread opens its harness's Desktop app, so the terminal
owners, `selection-required` result, and terminal-app choices were removed.
The adapter never uses process ancestry, Accessibility, Automation,
AppleScript, shell commands, or commands that create/resume an agent session.

## Bundle identifier provenance

These identifiers are constants, not renderer-controlled input. On 2026-09-15,
the installed applications were checked read-only from their `Contents/Info.plist`
metadata with `defaults read`:

| Application    | Bundle identifier                | Evidence                               |
| -------------- | -------------------------------- | -------------------------------------- |
| Codex Desktop  | `com.openai.codex`               | `/Applications/ChatGPT.app` Info.plist |
| Claude Desktop | `com.anthropic.claudefordesktop` | `/Applications/Claude.app` Info.plist  |

Bundle absence and `/usr/bin/open` failures are returned as typed failures
without guessing another application.

Process execution has a 2-second per-command timeout and retains at most 8 KiB
of combined output internally. One navigation runs at a time; a concurrent
request is a typed `busy` failure. If a timed-out or errored child does not
emit `close` within the bounded termination grace period, the result is the
explicit `cleanup-unconfirmed` failure and the runner retains ownership and
refuses to spawn another child until that close is observed. No process output
is returned in navigation results.

## Island clicks

Each island column is a button for its harness. Its click reaches the main
process as an `overlay:open-session` request with the session ID and, when the
opened thread has an unread completion, the completion the click saw. The
runtime's overlay projection marks every shown thread `canOpen`, because every
thread opens its harness's Desktop app.

`openIslandSession` in `src/main/navigation/session-opener.ts` accepts only a
top-level, unarchived, openable session in the island's current state and asks
`navigationTarget` for its target: a Codex Desktop thread whose ID is a task
UUID (the catalog thread ID) opens exactly; any other Codex thread, CLI threads
included, activates Codex Desktop; every Claude thread, CLI threads included,
activates Claude Desktop. The completion is acknowledged only after the
navigator reports `dispatched`, and only if it is still the thread's current
completion. A successful open also ends keyboard mode, when it is active,
without restoring the previously active app, since the harness is now in
front.

The test runtime (`NODE_ENV=test`, unpackaged) runs the real `MacOsNavigator`
with a command runner that records each `/usr/bin/open` argument list under
`Symbol.for('agent-status-tiles.test.navigations')` instead of running it, so
the navigator's target rules apply while E2E runs never switch the developer's
frontmost app.

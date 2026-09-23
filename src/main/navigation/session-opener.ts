import type {
  OverlayActionResult,
  OverlayOpenSessionRequest,
  OverlayState,
} from '../../shared/overlay-ipc';
import type { SessionSnapshot } from '../../shared/session';
import {
  isCodexTaskId,
  type NavigationResult,
  type QualifiedNavigationTarget,
  type TerminalApplication,
} from './macos-navigator';

export interface SessionNavigator {
  navigate(target: QualifiedNavigationTarget): Promise<NavigationResult>;
}

export interface SessionOpenerOptions {
  navigator: SessionNavigator;
  /** The sessions the island was shown; only these can be opened. */
  getState: () => OverlayState;
  /** The terminal that launched a CLI session, when a harness recorded it. */
  cliOwner: (session: SessionSnapshot) => Promise<TerminalApplication | 'unknown'>;
  acknowledge: (sessionId: string, completionId: string) => Promise<boolean>;
}

const UNAVAILABLE: OverlayActionResult = { handled: false, reason: 'unavailable' };
const FAILED: OverlayActionResult = { handled: false, reason: 'failed' };

function nativeSessionId(session: Pick<SessionSnapshot, 'id' | 'provider'>): string {
  return session.id.slice(session.provider.length + 1);
}

/**
 * Whether the navigator can bring this thread forward: a Codex Desktop thread
 * with a task UUID, any Claude Desktop thread, and a Claude CLI thread whose
 * launching terminal is known. Codex CLI threads record no terminal.
 */
export function canNavigateTo(
  session: Pick<SessionSnapshot, 'id' | 'provider' | 'surface'>,
  hasKnownTerminal: boolean,
): boolean {
  if (session.provider === 'codex') {
    return session.surface === 'desktop' && isCodexTaskId(nativeSessionId(session));
  }
  return session.surface === 'desktop' || hasKnownTerminal;
}

async function navigationTarget(
  session: SessionSnapshot,
  cliOwner: SessionOpenerOptions['cliOwner'],
): Promise<QualifiedNavigationTarget> {
  const native = nativeSessionId(session);
  if (session.surface === 'desktop') {
    return session.provider === 'codex'
      ? { provider: 'codex', surface: 'desktop', nativeSessionId: native, owner: 'codex-desktop' }
      : {
          provider: 'claude',
          surface: 'desktop',
          nativeSessionId: native,
          owner: 'claude-desktop',
        };
  }
  return {
    provider: session.provider,
    surface: 'cli',
    nativeSessionId: native,
    owner: await cliOwner(session),
  };
}

/**
 * Open a thread the island shows in its harness. A completion the click saw
 * is acknowledged only once navigation was dispatched, and only if it is
 * still the thread's current completion.
 */
export async function openIslandSession(
  request: OverlayOpenSessionRequest,
  options: SessionOpenerOptions,
): Promise<OverlayActionResult> {
  const session = options
    .getState()
    .sessions.find((candidate) => candidate.id === request.sessionId);
  // Only a thread the island shows: top-level, not archived, and openable.
  if (
    session === undefined ||
    !session.isTopLevel ||
    session.isArchived ||
    !session.canOpen ||
    // The terminal of a CLI thread is resolved below.
    !canNavigateTo(session, true)
  ) {
    return UNAVAILABLE;
  }
  let result: NavigationResult;
  try {
    result = await options.navigator.navigate(await navigationTarget(session, options.cliOwner));
  } catch {
    return FAILED;
  }
  if (result.status === 'selection-required') return UNAVAILABLE;
  if (result.status === 'failed') {
    return result.reason === 'invalid-target' || result.reason === 'unsupported-platform'
      ? UNAVAILABLE
      : FAILED;
  }
  if (request.completionId !== undefined) {
    await options.acknowledge(session.id, request.completionId).catch(() => false);
  }
  return { handled: true };
}

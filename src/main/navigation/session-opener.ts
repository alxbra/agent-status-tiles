import type {
  OverlayActionResult,
  OverlayOpenSessionRequest,
  OverlayState,
} from '../../shared/overlay-ipc';
import type { SessionSnapshot } from '../../shared/session';
import type {
  NavigationResult,
  QualifiedNavigationTarget,
  TerminalApplication,
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

function nativeSessionId(session: SessionSnapshot): string {
  return session.id.slice(session.provider.length + 1);
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
  if (session === undefined || !session.canOpen) return UNAVAILABLE;
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

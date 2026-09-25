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
} from './macos-navigator';

export interface SessionNavigator {
  navigate(target: QualifiedNavigationTarget): Promise<NavigationResult>;
}

export interface SessionOpenerOptions {
  navigator: SessionNavigator;
  /** The sessions the island was shown; only these can be opened. */
  getState: () => OverlayState;
  acknowledge: (sessionId: string, completionId: string) => Promise<boolean>;
}

const UNAVAILABLE: OverlayActionResult = { handled: false, reason: 'unavailable' };
const FAILED: OverlayActionResult = { handled: false, reason: 'failed' };

function nativeSessionId(session: Pick<SessionSnapshot, 'id' | 'provider'>): string {
  return session.id.slice(session.provider.length + 1);
}

/**
 * Every thread opens its harness's Desktop app (the user asked for this on
 * 2026-09-25): a Codex Desktop thread with a task UUID opens exactly, and any
 * other thread, CLI threads included, only brings its Desktop app forward.
 */
export function navigationTarget(
  session: Pick<SessionSnapshot, 'id' | 'provider' | 'surface'>,
): QualifiedNavigationTarget {
  const native = nativeSessionId(session);
  if (session.provider === 'codex' && session.surface === 'desktop' && isCodexTaskId(native)) {
    return { kind: 'codex-thread', nativeSessionId: native };
  }
  return {
    kind: 'application',
    application: session.provider === 'codex' ? 'codex-desktop' : 'claude-desktop',
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
  if (session === undefined || !session.isTopLevel || session.isArchived || !session.canOpen) {
    return UNAVAILABLE;
  }
  let result: NavigationResult;
  try {
    result = await options.navigator.navigate(navigationTarget(session));
  } catch {
    return FAILED;
  }
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

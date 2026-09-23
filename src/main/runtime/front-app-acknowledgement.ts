import type { SessionSnapshot, Surface, Provider } from '../../shared/session';
import { MACOS_APPLICATIONS } from '../navigation/macos-navigator';

interface SurfaceMatch {
  provider?: Provider;
  surface: Surface;
}

/**
 * Which sessions an activated app shows. The desktop apps own their provider's
 * Desktop surface. Terminal ownership of CLI sessions is not tracked yet, so
 * any qualified terminal counts for both providers' CLI sessions.
 */
const SURFACES_BY_BUNDLE: ReadonlyMap<string, readonly SurfaceMatch[]> = new Map([
  [MACOS_APPLICATIONS.codexDesktop.bundleId, [{ provider: 'codex', surface: 'desktop' }]],
  [MACOS_APPLICATIONS.claudeDesktop.bundleId, [{ provider: 'claude', surface: 'desktop' }]],
  ...[
    MACOS_APPLICATIONS.terminal,
    MACOS_APPLICATIONS.iterm2,
    MACOS_APPLICATIONS.ghostty,
    MACOS_APPLICATIONS.warp,
  ].map((application) => [application.bundleId, [{ surface: 'cli' }]] as [string, SurfaceMatch[]]),
]);

export interface CompletionAcknowledgement {
  sessionId: string;
  completionId: string;
}

/**
 * The unread completions to acknowledge when an app becomes frontmost:
 * switching to a harness counts as seeing what it finished.
 */
export function completionsSeenOnActivation(
  bundleId: string,
  sessions: readonly SessionSnapshot[],
): readonly CompletionAcknowledgement[] {
  const matches = SURFACES_BY_BUNDLE.get(bundleId);
  if (matches === undefined) return [];
  return sessions.flatMap((session) =>
    session.status === 'unread' &&
    session.completionId !== undefined &&
    matches.some(
      (match) =>
        match.surface === session.surface &&
        (match.provider === undefined || match.provider === session.provider),
    )
      ? [{ sessionId: session.id, completionId: session.completionId }]
      : [],
  );
}

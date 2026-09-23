import type { SessionSnapshot, Surface, Provider } from '../../shared/session';
import { MACOS_APPLICATIONS } from '../navigation/macos-navigator';

interface SurfaceMatch {
  provider: Provider;
  surface: Surface;
}

const CLI_SURFACES: readonly SurfaceMatch[] = [
  { provider: 'codex', surface: 'cli' },
  { provider: 'claude', surface: 'cli' },
];

/**
 * Which sessions an activated app shows. The desktop apps own their provider's
 * Desktop surface. Terminal ownership of CLI sessions is not tracked yet, so
 * any qualified terminal counts for both providers' CLI sessions.
 */
const SURFACES_BY_BUNDLE: ReadonlyMap<string, readonly SurfaceMatch[]> = new Map([
  [MACOS_APPLICATIONS.codexDesktop.bundleId, [{ provider: 'codex', surface: 'desktop' }]],
  [MACOS_APPLICATIONS.claudeDesktop.bundleId, [{ provider: 'claude', surface: 'desktop' }]],
  [MACOS_APPLICATIONS.terminal.bundleId, CLI_SURFACES],
  [MACOS_APPLICATIONS.iterm2.bundleId, CLI_SURFACES],
  [MACOS_APPLICATIONS.ghostty.bundleId, CLI_SURFACES],
  [MACOS_APPLICATIONS.warp.bundleId, CLI_SURFACES],
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
      (match) => match.surface === session.surface && match.provider === session.provider,
    )
      ? [{ sessionId: session.id, completionId: session.completionId }]
      : [],
  );
}

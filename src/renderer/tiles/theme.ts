import type { SessionStatus, Provider } from '../../shared/session';

/**
 * The status colors and glyph color are shared with codex-status-actions
 * (Apache-2.0, https://github.com/alxbra/codex-status-actions).
 */
export const TILE_COLORS = {
  neutral: '#F1F1ED',
  green: '#8FEA98',
  blue: '#8DCEF5',
  orange: '#FF8A3D',
  red: '#FF6B73',
  glyph: '#111315',
} as const;

export const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: TILE_COLORS.neutral,
  unavailable: TILE_COLORS.neutral,
  unread: TILE_COLORS.green,
  working: TILE_COLORS.blue,
  'needs-input': TILE_COLORS.orange,
  error: TILE_COLORS.red,
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  codex: 'OpenAI',
  claude: 'Anthropic',
};

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'needs-input':
      return 'waiting for input';
    case 'unread':
      return 'completed';
    case 'working':
      return 'working';
    case 'error':
      return 'error';
    case 'unavailable':
      return 'unavailable';
    case 'idle':
      return 'idle';
  }
}

export function sessionDisplayTitle(title: string, sessionId: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > 0) return trimmedTitle;

  const lastIdPart = sessionId
    .split(/[/\\:]/u)
    .filter(Boolean)
    .at(-1);
  return lastIdPart ?? 'Session';
}

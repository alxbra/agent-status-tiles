import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { SessionSnapshot } from '../../src/shared/session';
import { StatusTiles, type OpenSessionTarget } from '../../src/renderer/tiles';
import './status-tiles-fixture.css';

declare global {
  interface Window {
    __setFixtureSessions?: (sessions: readonly SessionSnapshot[]) => void;
    __fixtureOpenTarget?: OpenSessionTarget;
    __fixtureDismissedSessionId?: string;
    __fixtureHitRegions?: unknown;
  }
}

function makeSessions(count: number, forceError = false): readonly SessionSnapshot[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `${index % 2 === 0 ? 'codex' : 'claude'}:fixture-${index}`,
        provider: index % 2 === 0 ? 'codex' : 'claude',
        surface: index % 2 === 0 ? 'desktop' : 'cli',
        title: `Fixture session ${index + 1}`,
        status:
          forceError && index === 0
            ? 'error'
            : index === 0
              ? 'unread'
              : index % 5 === 0
                ? 'needs-input'
                : 'working',
        updatedAt: index + 1,
        lastTurnStartedAt: index + 1,
        completionId: index === 0 ? 'completion-1' : undefined,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      }) satisfies SessionSnapshot,
  );
}

export function Fixture(): ReactElement {
  const query = new URLSearchParams(window.location.search);
  const count = Math.max(0, Number(query.get('count') ?? 1));
  const reducedMotion = query.get('reduced') === '1';
  const forceError = query.get('error') === '1';
  const [sessions, setSessions] = useState<readonly SessionSnapshot[]>(() =>
    makeSessions(count, forceError),
  );
  window.__setFixtureSessions = setSessions;

  return (
    <StatusTiles
      sessions={sessions}
      reducedMotion={reducedMotion}
      height={480}
      onOpenSession={(target) => {
        window.__fixtureOpenTarget = target;
      }}
      onDismissError={(sessionId) => {
        window.__fixtureDismissedSessionId = sessionId;
      }}
      onHitRegionsChange={(regions) => {
        window.__fixtureHitRegions = regions;
      }}
      onKeyboardExit={() => {
        document.body.dataset.keyboardExit = 'true';
      }}
    />
  );
}

createRoot(document.getElementById('fixture-root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

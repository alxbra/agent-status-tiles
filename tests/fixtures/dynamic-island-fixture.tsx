import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { SessionSnapshot, SessionStatus } from '../../src/shared/session';
import { DynamicIsland } from '../../src/renderer/island/DynamicIsland';
import { SLEEPING_POSES } from '../../src/renderer/island/frenchie-poses';
import { SleepingSprite } from '../../src/renderer/island/SleepingSprite';
import { playSuccessCue } from '../../src/renderer/island/success-cue';
import type { OpenSessionTarget } from '../../src/renderer/island/interaction';
import './dynamic-island-fixture.css';

declare global {
  interface Window {
    __setIslandSessions?: (sessions: readonly SessionSnapshot[]) => void;
    __triggerKeyboardEntry?: () => void;
    __islandOpenTarget?: OpenSessionTarget;
    __islandHitRegions?: unknown;
    __islandKeyboardExits?: number;
    __islandTurnsFinished?: number;
  }
}

function session(
  id: string,
  provider: SessionSnapshot['provider'],
  status: SessionStatus,
  updatedAt: number,
): SessionSnapshot {
  return {
    id: `${provider}:${id}`,
    provider,
    surface: provider === 'codex' ? 'desktop' : 'cli',
    title: `Fixture ${id}`,
    status,
    updatedAt,
    lastTurnStartedAt: updatedAt,
    ...(status === 'unread' ? { completionId: `completion-${id}` } : {}),
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
  };
}

const FIXTURE_STATES: Record<string, readonly SessionSnapshot[]> = {
  idle: [session('a', 'codex', 'idle', 1), session('b', 'claude', 'idle', 2)],
  'claude-only': [session('a', 'codex', 'idle', 1), session('b', 'claude', 'working', 2)],
  working: [session('a', 'codex', 'working', 3), session('b', 'claude', 'unread', 2)],
  'both-working': [session('a', 'codex', 'working', 5), session('b', 'claude', 'working', 4)],
  'needs-input': [
    session('a', 'codex', 'working', 5),
    session('b', 'claude', 'unread', 4),
    session('c', 'codex', 'needs-input', 3),
  ],
  mixed: [session('a', 'codex', 'working', 5), session('b', 'claude', 'needs-input', 4)],
};

const params = new URLSearchParams(window.location.search);
document.body.dataset.fixtureTheme = params.get('theme') === 'light' ? 'light' : 'dark';
const reducedMotion = params.get('motion') === 'reduced';
const playsSound = params.get('sound') === 'real';

function IslandFixture({ initial }: { initial: readonly SessionSnapshot[] }): ReactElement {
  const [sessions, setSessions] = useState(initial);
  const [keyboardEntryRevision, setKeyboardEntryRevision] = useState(0);
  window.__setIslandSessions = setSessions;
  window.__triggerKeyboardEntry = () => setKeyboardEntryRevision((revision) => revision + 1);
  return (
    <DynamicIsland
      sessions={sessions}
      reducedMotion={reducedMotion}
      keyboardEntryRevision={keyboardEntryRevision}
      onOpenSession={(target) => {
        window.__islandOpenTarget = target;
      }}
      onHitRegionsChange={(regions) => {
        window.__islandHitRegions = regions;
      }}
      onKeyboardExit={() => {
        window.__islandKeyboardExits = (window.__islandKeyboardExits ?? 0) + 1;
      }}
      onTurnFinished={() => {
        window.__islandTurnsFinished = (window.__islandTurnsFinished ?? 0) + 1;
        if (playsSound) playSuccessCue();
      }}
    />
  );
}

function Gallery(): ReactElement {
  return (
    <div className="fixture-gallery">
      {Object.entries(FIXTURE_STATES).map(([name, sessions]) => (
        <section key={name} data-state={name}>
          <DynamicIsland
            sessions={sessions}
            reducedMotion={reducedMotion}
            onOpenSession={() => undefined}
            onHitRegionsChange={() => undefined}
            onKeyboardExit={() => undefined}
          />
        </section>
      ))}
    </div>
  );
}

/** Every sleeping pose in an island-shaped pill, for review. */
function Sleepers(): ReactElement {
  return (
    <div className="fixture-gallery">
      {SLEEPING_POSES.map((pose, index) => (
        <section key={pose.name}>
          <div
            className={
              reducedMotion ? 'dynamic-island dynamic-island--reduced-motion' : 'dynamic-island'
            }
          >
            <div className="fixture-sleeper">
              <SleepingSprite pose={index} />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

const state = params.get('state') ?? 'gallery';
createRoot(document.getElementById('fixture-root')!).render(
  <StrictMode>
    {state === 'gallery' ? (
      <Gallery />
    ) : state === 'sleepers' ? (
      <Sleepers />
    ) : (
      <IslandFixture initial={FIXTURE_STATES[state] ?? FIXTURE_STATES.idle!} />
    )}
  </StrictMode>,
);

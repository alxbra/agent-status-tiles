import type { ReactElement } from 'react';

import {
  FRENCHIE_COLORS,
  SLEEPING_POSES,
  type FrenchieColor,
  type SleepingPose,
} from './frenchie-poses';

const PIXEL = 2;
/** Each z is a 5-pixel glyph on the sprite's pixel grid. */
const Z_SIZE = 5;
const Z_PIXEL = PIXEL;

function isFrenchieColor(cell: string): cell is FrenchieColor {
  return Object.hasOwn(FRENCHIE_COLORS, cell);
}

/** One path per color, each row's runs merged into single rectangles. */
function colorPaths(rows: readonly string[]): readonly (readonly [FrenchieColor, string])[] {
  const paths = new Map<FrenchieColor, string>();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      if (isFrenchieColor(cell)) {
        const run = `M${String(x)} ${String(y)}h${String(end - x)}v1h-${String(end - x)}z`;
        paths.set(cell, (paths.get(cell) ?? '') + run);
      }
      x = end;
    }
  });
  return [...paths];
}

/** The poses never change, so their paths are drawn once. */
const POSE_PATHS = SLEEPING_POSES.map(({ frame, twitch }) => ({
  frame: colorPaths(frame),
  twitch: colorPaths(twitch),
}));

function Frame({
  paths,
  className,
}: {
  paths: readonly (readonly [FrenchieColor, string])[];
  className: string;
}): ReactElement {
  return (
    <g className={className}>
      {paths.map(([color, d]) => (
        <path key={color} d={d} fill={FRENCHIE_COLORS[color]} />
      ))}
    </g>
  );
}

/**
 * Shown when no harness is active: a sleeping frenchie in one of several
 * poses, breathing and now and then twitching under drifting z's.
 */
export function SleepingSprite({ pose }: { pose: number }): ReactElement {
  const index = SLEEPING_POSES[pose] === undefined ? 0 : pose;
  const { name, frame }: SleepingPose = SLEEPING_POSES[index]!;
  const paths = POSE_PATHS[index]!;
  const width = frame[0]?.length ?? 0;
  const height = frame.length;
  return (
    <span
      className="dynamic-island__sleeper"
      role="img"
      aria-label="All agents idle"
      data-pose={name}
    >
      <svg
        className="dynamic-island__sleeper-sprite"
        width={width * PIXEL}
        height={height * PIXEL}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        <Frame paths={paths.frame} className="dynamic-island__sleeper-frame" />
        <Frame paths={paths.twitch} className="dynamic-island__sleeper-twitch" />
      </svg>
      <span className="dynamic-island__sleeper-z" aria-hidden="true">
        {[0, 1].map((z) => (
          <svg
            key={z}
            className="dynamic-island__z"
            width={Z_SIZE * Z_PIXEL}
            height={Z_SIZE * Z_PIXEL}
            viewBox={`0 0 ${String(Z_SIZE)} ${String(Z_SIZE)}`}
            shapeRendering="crispEdges"
            style={{ animationDelay: `${String(z * 1200)}ms` }}
          >
            <path d="M0 0h5v1H0zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM0 4h5v1H0z" />
          </svg>
        ))}
      </span>
    </span>
  );
}

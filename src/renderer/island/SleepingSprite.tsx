import type { ReactElement } from 'react';

/**
 * A pixel cat curled up asleep, drawn on a 2 px grid: `#` is fur and `-` a
 * closed eye in the island's black.
 */
const SLEEPER = [
  '.#.....#.........',
  '.##...##.........',
  '.#######..#####..',
  '#########.######.',
  '##--#--##########',
  '#################',
  '.###############.',
  '..##.##.....###..',
] as const;

const PIXEL = 2;
/** Each z is a 5-pixel glyph on the cat's pixel grid. */
const Z_SIZE = 5;
const Z_PIXEL = PIXEL;
const WIDTH = SLEEPER[0].length;
const HEIGHT = SLEEPER.length;

function pixels(mark: string): readonly [number, number][] {
  return SLEEPER.flatMap((row, y) =>
    [...row].flatMap((cell, x) => (cell === mark ? [[x, y] as [number, number]] : [])),
  );
}

const FUR = pixels('#');
const EYES = pixels('-');

/** Shown when no harness is active: a sleeping cat breathing under drifting z's. */
export function SleepingSprite(): ReactElement {
  return (
    <span className="dynamic-island__sleeper" role="img" aria-label="All agents idle">
      <svg
        className="dynamic-island__sleeper-cat"
        width={WIDTH * PIXEL}
        height={HEIGHT * PIXEL}
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {FUR.map(([x, y]) => (
          <rect key={`f${String(x)}-${String(y)}`} x={x} y={y} width={1} height={1} />
        ))}
        {EYES.map(([x, y]) => (
          <rect
            key={`e${String(x)}-${String(y)}`}
            className="dynamic-island__sleeper-eye"
            x={x}
            y={y}
            width={1}
            height={1}
          />
        ))}
      </svg>
      <span className="dynamic-island__sleeper-z" aria-hidden="true">
        {[0, 1].map((index) => (
          <svg
            key={index}
            className="dynamic-island__z"
            width={Z_SIZE * Z_PIXEL}
            height={Z_SIZE * Z_PIXEL}
            viewBox={`0 0 ${String(Z_SIZE)} ${String(Z_SIZE)}`}
            shapeRendering="crispEdges"
            style={{ animationDelay: `${String(index * 1200)}ms` }}
          >
            <path d="M0 0h5v1H0zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM0 4h5v1H0z" />
          </svg>
        ))}
      </span>
    </span>
  );
}

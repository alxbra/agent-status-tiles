/**
 * The sleeping island's frenchie, drawn after the product owner's own dog
 * (asked for on 2026-09-25): a fawn coat, near-black bat ears and eye patches,
 * a grey muzzle, and a white blaze and chest. Each pose is a 12-row grid of
 * 2 px pixels plus a twitch frame that flashes now and then.
 */

/** Fur and bed colors; `.` is transparent. None of them is a status color. */
export const FRENCHIE_COLORS = {
  K: '#3B322D', // ears, eye patches, and muzzle
  k: '#6A4E42', // inner ear
  F: '#C9966B', // fawn coat
  f: '#A8774F', // fawn shade
  W: '#F1F1ED', // blaze and chest
  G: '#9A948E', // grey muzzle
  E: '#B9A89A', // closed eyes
  N: '#000000', // nose
  R: '#5E5A57', // bed
  r: '#77726E', // bed rim
  P: '#8A6F63', // paw pads
} as const;

export type FrenchieColor = keyof typeof FRENCHIE_COLORS;

export interface SleepingPose {
  name: string;
  /** The resting frame, one string per pixel row. */
  frame: readonly string[];
  /** The same grid with a small twitch: an ear flick or a paw moving. */
  twitch: readonly string[];
}

export const SLEEPING_POSES: readonly SleepingPose[] = [
  // Head resting on its paws; the right ear flicks.
  {
    name: 'head-on-paws',
    frame: [
      '.KK...........KK.',
      'KkkK.........KkkK',
      'KkkkK.......KkkkK',
      'KkkkK.......KkkkK',
      '.KkkKFFFFFFFKkkK.',
      '.FKKKFFFWFFFKKKF.',
      'FKEEEKFFFFFKEEEKF',
      'FFKKKFFFFFFFKKKFF',
      'FFFFFKKNNNKKFFFFF',
      'fFFFKKKKKKKKKFFFf',
      '.fFFGKGGGGGKGFFf.',
      'FFFWWWWWWWWWWWFFF',
    ],
    twitch: [
      '.KK.............K',
      'KkkK..........KKK',
      'KkkkK.......KkkkK',
      'KkkkK.......KkkkK',
      '.KkkKFFFFFFFKkkK.',
      '.FKKKFFFWFFFKKKF.',
      'FKEEEKFFFFFKEEEKF',
      'FFKKKFFFFFFFKKKFF',
      'FFFFFKKNNNKKFFFFF',
      'fFFFKKKKKKKKKFFFf',
      '.fFFGKGGGGGKGFFf.',
      'FFFWWWWWWWWWWWFFF',
    ],
  },
  // Curled up on its side; the ear tips back.
  {
    name: 'curled-up',
    frame: [
      '....KK..................',
      '...KkkK.................',
      '...KkkK.................',
      '...KkkK.......ffFFFF....',
      '...FKkKFF...fFFFFFFFFF..',
      '..FFFFFFFF.fFFFFFFFFFFF.',
      '.KKEEKFFFFfFFFFFFFFFFFFF',
      'NKKKKKFFFFFFFFFFFFFFFFFF',
      'KKGGKFFWWfFFFFFFFFFFFFFf',
      '.GGKFFWWWFfFFFFFFFFFFFf.',
      '..FFFFWWFFFfffffffffff..',
      '.FFF..FF.......FF.FF....',
    ],
    twitch: [
      '.....KK.................',
      '....kkKK................',
      '...KkkK.................',
      '...KkkK.......ffFFFF....',
      '...FKkKFF...fFFFFFFFFF..',
      '..FFFFFFFF.fFFFFFFFFFFF.',
      '.KKEEKFFFFfFFFFFFFFFFFFF',
      'NKKKKKFFFFFFFFFFFFFFFFFF',
      'KKGGKFFWWfFFFFFFFFFFFFFf',
      '.GGKFFWWWFfFFFFFFFFFFFf.',
      '..FFFFWWFFFfffffffffff..',
      '.FFF..FF.......FF.FF....',
    ],
  },
  // Belly up with its paws in the air; the paws paddle.
  {
    name: 'belly-up',
    frame: [
      '.........ff.........ff...',
      '.........FF.........FF...',
      '.......FFF.........FFF...',
      '.....FFFFWWWWWWWWWWFFFF..',
      '....FFWWWWWWWWWWWWWWWFFF.',
      '..KFFWWWWWWWWWWWWWWWWFFFf',
      '.KkKFFFFFFFFFFFFFFFFFFFf.',
      'KkkKFKKFFfffffffffffff...',
      'KkKFKEEKF................',
      '.KFFFKKKF................',
      '..FKKNNKF................',
      '...GGGGG.................',
    ],
    twitch: [
      '..........ff.......ff....',
      '.........FF.........FF...',
      '.......FFF.........FFF...',
      '.....FFFFWWWWWWWWWWFFFF..',
      '....FFWWWWWWWWWWWWWWWFFF.',
      '..KFFWWWWWWWWWWWWWWWWFFFf',
      '.KkKFFFFFFFFFFFFFFFFFFFf.',
      'KkkKFKKFFfffffffffffff...',
      'KkKFKEEKF................',
      '.KFFFKKKF................',
      '..FKKNNKF................',
      '...GGGGG.................',
    ],
  },
  // Peeking over the rim of a donut bed; the right ear flicks.
  {
    name: 'donut-bed',
    frame: [
      '....KK.......KK....',
      '...KkkK.....KkkK...',
      '...KkkK.....KkkK...',
      '....KkKFFFFFKkK....',
      '....FKKKFWFKKKF....',
      '...FKEEKFFFKEEKF...',
      '...FFKKKKNKKKKFF...',
      '.rrrfFKKGGGKKFfrrr.',
      'rRRRRFFWWWWWFFRRRRr',
      'RRRRRRRRRRRRRRRRRRR',
      'rRRRRRRRRRRRRRRRRRr',
      '.rrrrrrrrrrrrrrrrr.',
    ],
    twitch: [
      '....KK.........KK..',
      '...KkkK......kkKK..',
      '...KkkK.....KkkK...',
      '....KkKFFFFFKkK....',
      '....FKKKFWFKKKF....',
      '...FKEEKFFFKEEKF...',
      '...FFKKKKNKKKKFF...',
      '.rrrfFKKGGGKKFfrrr.',
      'rRRRRFFWWWWWFFRRRRr',
      'RRRRRRRRRRRRRRRRRRR',
      'rRRRRRRRRRRRRRRRRRr',
      '.rrrrrrrrrrrrrrrrr.',
    ],
  },
  // Splooted flat, seen from above; a back paw stretches.
  {
    name: 'sploot',
    frame: [
      '..KK.......................',
      '.KkkK......................',
      '.KkkK.............FFFFFFFP.',
      '..KFFF..FFFFFFFFFFf........',
      'PFFFFFFFFFFFFFFFFFFF.......',
      '..FFFFFFFFFFFFFFFFFFf......',
      '..FFFFFFFFFFFFFFFFFFf......',
      'PFFFFFFFFFFFFFFFFFFF.......',
      '..KFFF..FFFFFFFFFFf........',
      '.KkkK.............FFFFFFFP.',
      '.KkkK......................',
      '..KK.......................',
    ],
    twitch: [
      '..KK.......................',
      '.KkkK......................',
      '.KkkK.............FFFFFFFFP',
      '..KFFF..FFFFFFFFFFf........',
      'PFFFFFFFFFFFFFFFFFFF.......',
      '..FFFFFFFFFFFFFFFFFFf......',
      '..FFFFFFFFFFFFFFFFFFf......',
      'PFFFFFFFFFFFFFFFFFFF.......',
      '..KFFF..FFFFFFFFFFf........',
      '.KkkK.............FFFFFFFP.',
      '.KkkK......................',
      '..KK.......................',
    ],
  },
];

/**
 * A random pose index that differs from the previous one, so each time the
 * island falls asleep it shows a different frenchie.
 */
export function pickSleepingPose(
  previous: number | undefined,
  random: () => number = Math.random,
): number {
  const count = SLEEPING_POSES.length;
  if (previous === undefined || count < 2) return Math.min(count - 1, Math.floor(random() * count));
  const index = Math.min(count - 2, Math.floor(random() * (count - 1)));
  return index >= previous ? index + 1 : index;
}

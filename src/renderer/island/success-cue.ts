/**
 * Cuelume's `success` cue, adapted from Cuelume 0.2.2
 * (MIT, Copyright (c) 2026 Daniel Belyi, https://cuelume.dev/; the license
 * text is in THIRD_PARTY_NOTICES.md). Cuelume refuses to play before the page
 * has seen a user gesture, and the overlay never takes focus, so the recipe
 * and the parts of its engine this cue uses are vendored here.
 */

interface ToneLayer {
  frequency: number;
  offset: number;
  attack: number;
  decay: number;
  peak: number;
}

const SUCCESS = {
  masterGain: 0.5,
  layers: [
    { frequency: 880, offset: 0, attack: 0.004, decay: 0.09, peak: 0.06 },
    { frequency: 1108.73, offset: 0.06, attack: 0.004, decay: 0.1, peak: 0.06 },
    { frequency: 1318.51, offset: 0.12, attack: 0.004, decay: 0.18, peak: 0.07 },
  ] satisfies readonly ToneLayer[],
  shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 },
} as const;

const OUTPUT_GAIN = 4;
const SOURCE_STOP_PADDING = 0.05;
const CLEANUP_MARGIN = 0.05;
const INAUDIBLE_GAIN = 0.001;

let sharedContext: AudioContext | null = null;
let sharedOutput: GainNode | null = null;

function audioContext(): AudioContext | null {
  if (sharedContext !== null) return sharedContext;
  try {
    sharedContext = new AudioContext();
  } catch {
    // No audio device or audio disabled: the cue is simply silent.
    return null;
  }
  return sharedContext;
}

/** One gain stage into a gentle limiter, shared by every cue. */
function output(context: AudioContext): GainNode {
  if (sharedOutput !== null) return sharedOutput;
  const gain = context.createGain();
  gain.gain.value = OUTPUT_GAIN;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  gain.connect(limiter).connect(context.destination);
  sharedOutput = gain;
  return gain;
}

function renderTone(context: AudioContext, destination: AudioNode, layer: ToneLayer): void {
  const start = context.currentTime + layer.offset;
  const oscillator = context.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(layer.frequency, start);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(layer.peak, start + layer.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + layer.attack + layer.decay);
  oscillator.connect(gain).connect(destination);
  oscillator.start(start);
  oscillator.stop(start + layer.attack + layer.decay + SOURCE_STOP_PADDING);
}

function render(context: AudioContext): void {
  const destination = output(context);
  const master = context.createGain();
  master.gain.value = SUCCESS.masterGain;
  master.connect(destination);

  // A soft echo whose filtered feedback fades out after a few repeats.
  const { shimmer } = SUCCESS;
  const delay = context.createDelay(1);
  delay.delayTime.value = shimmer.delay;
  const feedbackFilter = context.createBiquadFilter();
  feedbackFilter.type = 'lowpass';
  feedbackFilter.frequency.value = shimmer.lowpass;
  const feedbackGain = context.createGain();
  feedbackGain.gain.value = shimmer.feedback;
  const wetGain = context.createGain();
  wetGain.gain.value = shimmer.wet;
  master.connect(delay);
  delay.connect(feedbackFilter);
  feedbackFilter.connect(feedbackGain);
  feedbackGain.connect(delay);
  feedbackFilter.connect(wetGain);
  wetGain.connect(destination);

  for (const layer of SUCCESS.layers) renderTone(context, master, layer);

  const sourceEnd = Math.max(
    ...SUCCESS.layers.map(
      (layer) => layer.offset + layer.attack + layer.decay + SOURCE_STOP_PADDING,
    ),
  );
  const tail =
    shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)));
  window.setTimeout(
    () => {
      for (const node of [master, delay, feedbackFilter, feedbackGain, wetGain]) node.disconnect();
    },
    (sourceEnd + tail + CLEANUP_MARGIN) * 1000,
  );
}

/** Play the success cue once; never throws and never waits for a user gesture. */
export function playSuccessCue(): void {
  const context = audioContext();
  if (context === null) return;
  if (context.state === 'running') {
    render(context);
    return;
  }
  void context.resume().then(
    () => {
      if (context.state === 'running') render(context);
    },
    () => undefined,
  );
}

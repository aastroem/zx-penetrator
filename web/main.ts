import { Emu } from './emu';
import { Screen } from './gl';
import { attachKeyboard } from './input';
import { Beeper } from './audio';
import { edgesToSamples } from './audio-math';

const T_STATES_PER_SEC = 3_500_000;
const FRAME_TSTATES = 69888; // Spectrum: T-states per 50Hz frame
const MAX_OWED_TSTATES = 4 * FRAME_TSTATES; // catch-up clamp
const SAMPLE_RATE = 44100;
const SAMPLE_RATE_RATIO = SAMPLE_RATE / T_STATES_PER_SEC;

const emu = await Emu.create();
emu.boot();

const scr = new Screen(document.getElementById('screen') as HTMLCanvasElement);
attachKeyboard(emu);
addEventListener('resize', () => scr.resize());
scr.resize();

// --- Audio bring-up -------------------------------------------------------
// Browsers require a user gesture before audio can play, so the
// AudioContext is created (and the worklet module loaded) lazily on the
// first keydown/pointerdown. Until it's up and *running*, the game runs on
// the rAF/wall-clock fallback loop below; once running, tick() switches to
// audio-clock scheduling so the game clock is derived from
// `ctx.currentTime` and can never drift apart from what's actually playing.
let beeper: Beeper | null = null;
let audioCtx: AudioContext | null = null;
let audioT0 = 0; // ctx.currentTime when audio-clock scheduling took over
let audioDone = 0; // tstates executed since audioT0

function startAudio(): void {
  if (audioCtx) return; // already starting/started
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  audioCtx = ctx;
  void ctx.resume().then(async () => {
    beeper = await Beeper.create(ctx);
    audioT0 = ctx.currentTime;
    audioDone = 0;
  });
}
addEventListener('keydown', startAudio, { once: true });
addEventListener('pointerdown', startAudio, { once: true });

// --- Shared run/drain/draw step --------------------------------------------
// Used by both scheduling loops so they can never diverge: emu.drainAudio()
// must be called every tick regardless of whether audio is playing yet, or
// the core's fixed-size speaker-edge ring can overflow.
function step(owedTstates: number): void {
  const owed = Math.round(owedTstates);
  if (owed > 0) {
    const ran = emu.run(owed);
    const { ts, lv } = emu.drainAudio();
    if (beeper) beeper.push(edgesToSamples(ts, lv, ran, SAMPLE_RATE_RATIO));
    if (audioCtx) audioDone += ran;
  }
  scr.draw(emu.screen(), emu.border(), emu.frame());
}

// --- Scheduling loop --------------------------------------------------------
let last = performance.now();

function tick(now: number): void {
  if (audioCtx && audioCtx.state === 'running' && beeper) {
    const rawOwed = (audioCtx.currentTime - audioT0) * T_STATES_PER_SEC - audioDone;
    if (rawOwed > T_STATES_PER_SEC) {
      // Tab was parked (backgrounded/minimized) for a long stretch: never
      // fast-forward audio/gameplay to catch up. Drop the backlog and
      // resume scheduling from now instead.
      audioDone = (audioCtx.currentTime - audioT0) * T_STATES_PER_SEC;
      step(0);
    } else {
      step(Math.max(0, Math.min(MAX_OWED_TSTATES, rawOwed)));
    }
  } else {
    // rAF/wall-clock fallback: used before the AudioContext exists (no user
    // gesture yet) and while it's still resuming.
    const owedFrames = Math.min(4, Math.round((now - last) / 20)); // 50Hz frames
    if (owedFrames > 0) {
      step(owedFrames * FRAME_TSTATES);
      last += owedFrames * 20;
    } else if (now - last > 1000) {
      last = now; // tab was parked
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

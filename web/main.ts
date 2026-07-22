import { Emu } from './emu';
import { Screen } from './gl';
import { attachKeyboard } from './input';
import { Beeper } from './audio';
import { edgesToSamples } from './audio-math';
import { Slots, attachHotkeys } from './state';

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

// --- Save states + landscape editor persistence ---------------------------
// F5/F8 = save/load slot 0 (see attachHotkeys). Slot buttons (1/2) and any
// "resume autosave?" affordance are Task 9's UI; here we only wire the
// mechanism. autoSaveOnUnload() intentionally never auto-restores on boot
// (see its doc comment in state.ts) — a stale run should never resume
// without the player asking for it.
const slots = new Slots(emu);
attachHotkeys(slots);
slots.autoSaveOnUnload();

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

// Speaker level carried across ticks so edgesToSamples() can render each
// tick's audio relative to what the speaker was actually doing, rather than
// guessing from that tick's own (possibly level-repeating) log entries. See
// audio-math.ts for why this can't be derived tick-locally.
let speakerLevel: 0 | 1 = 0;

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
  // Polled on every tick path (rAF fallback and audio-clock scheduling
  // alike) so a tape-save/load trap is never missed regardless of which
  // loop is currently driving the emulator, even on ticks that run 0
  // T-states. Note: the core's trap latch holds one value; two tape ops
  // within a single run window would coalesce (unreachable in the menu-driven UX).
  slots.pollTraps();
  const owed = Math.round(owedTstates);
  if (owed > 0) {
    const ran = emu.run(owed);
    const { ts, lv } = emu.drainAudio();
    // Always synthesize (even though Beeper.push() may go on to drop the
    // chunk when it's too far ahead of real-time playback): speakerLevel
    // must advance in lockstep with the emulator's run, or the next tick's
    // rendering would desync from what the speaker actually did during a
    // dropped chunk. The synthesis cost of an occasional dropped chunk is
    // the price of keeping level tracking exact.
    const { samples, endLevel } = edgesToSamples(ts, lv, ran, SAMPLE_RATE_RATIO, speakerLevel);
    speakerLevel = endLevel;
    if (beeper) beeper.push(samples);
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

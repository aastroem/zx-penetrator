import { Emu } from './emu';
import { Screen } from './gl';
import { attachKeyboard } from './input';
import { Beeper } from './audio';
import { edgesToSamples } from './audio-math';
import { Slots, attachHotkeys } from './state';
import { initUi, pollGamepad } from './ui';
import { pokeCredit, CREDIT_START_FRAME, CREDIT_END_FRAME } from './credit';

const T_STATES_PER_SEC = 3_500_000;
const FRAME_TSTATES = 69888; // Spectrum: T-states per 50Hz frame
const MAX_OWED_TSTATES = 4 * FRAME_TSTATES; // catch-up clamp
const SAMPLE_RATE = 44100;
const SAMPLE_RATE_RATIO = SAMPLE_RATE / T_STATES_PER_SEC;

// Renders a minimal, framework-free error card in place of the whole page.
// Used when bootstrap throws (missing WebGL2/WASM support, a fetch failure,
// etc.) so the visitor sees *something* actionable instead of a blank tab.
function showBootstrapError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  document.body.innerHTML = '';
  const card = document.createElement('div');
  card.style.cssText =
    'font-family: system-ui, sans-serif; max-width: 34em; margin: 4em auto; ' +
    'padding: 1.5em 2em; border: 1px solid #a55; border-radius: 8px; ' +
    'background: #2a1414; color: #eee; line-height: 1.5;';

  const heading = document.createElement('h1');
  heading.style.cssText = 'font-size: 1.2em; margin-top: 0;';
  heading.textContent = 'Failed to start';
  card.append(heading);

  const explanation = document.createElement('p');
  explanation.textContent =
    'This browser may lack WebGL2 or WASM support.';
  card.append(explanation);

  const detail = document.createElement('p');
  const code = document.createElement('code');
  code.textContent = message; // textContent: never interpret err as HTML
  detail.append(code);
  card.append(detail);

  const link = document.createElement('p');
  const a = document.createElement('a');
  a.href = 'https://github.com/aastroem/zx-penetrator/issues';
  a.textContent = 'Report this issue';
  a.style.color = '#8cf';
  link.append(a);
  card.append(link);

  document.body.append(card);
}

async function main(): Promise<void> {
  const emu = await Emu.create();
  emu.boot();

  const screenCanvas = document.getElementById('screen') as HTMLCanvasElement;
  const scr = new Screen(screenCanvas);
  attachKeyboard(emu);
  // Window resize is cheap belt-and-braces; the ResizeObserver below is what
  // actually tracks the canvas's available box (its container shrinks when
  // the in-flow topbar wraps to more lines, e.g. the keys-help <details>
  // expanding), independent of whether the window itself changed size.
  addEventListener('resize', () => scr.resize());
  const screenWrap = screenCanvas.parentElement;
  if (screenWrap && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scr.resize()).observe(screenWrap);
  }
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

  // --- Shell chrome: top bar, touch overlay, gamepad polling -----------------
  initUi({ emu, scr, slots });

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

  // "A Kim & Kenny Show production" credit (see credit.ts): baked straight
  // into the emulated screen's own memory, timed off the emulator's own
  // frame counter relative to the same first-gesture moment that starts
  // audio below (used here as a proxy for "the player just left the title
  // screen" — same heuristic, same gesture). credit.ts's frame window was
  // verified empirically against the real game's own screen writes.
  let creditFrame0: number | null = null; // emu.frame() at first gesture
  let creditPoked = false; // poke once per boot, on entering the window

  function startAudio(): void {
    if (creditFrame0 === null) creditFrame0 = emu.frame();
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
    // Re-poke the credit every tick while inside its reveal window (see
    // credit.ts): the game does a full screen clear during the logo→menu
    // transition (~frame 1400 after the title keypress), so a one-shot poke
    // at 1300 would be erased two seconds in. Idempotent display-memory
    // writes; once the window ends the game's own next clear removes it.
    if (creditFrame0 !== null && !creditPoked) {
      const elapsed = emu.frame() - creditFrame0;
      if (elapsed >= CREDIT_START_FRAME && elapsed <= CREDIT_END_FRAME) {
        pokeCredit(emu);
      } else if (elapsed > CREDIT_END_FRAME) {
        creditPoked = true; // window over — stop checking for good
      }
    }
    scr.draw(emu.screen(), emu.border(), emu.frame());
  }

  // --- Scheduling loop --------------------------------------------------------
  let last = performance.now();

  // Tracks whether the *previous* tick was driven by the wall-clock fallback
  // path rather than the audio clock. audioDone keeps accumulating during
  // fallback ticks (step() adds to it whenever audioCtx exists, even
  // suspended) while ctx.currentTime stands still, e.g. across an
  // AudioContext interruption (tab backgrounded and the context auto-
  // suspends). If the audio-clock path is then trusted as-is on resume, its
  // ledger owes deeply negative time. So: whenever the audio-clock path
  // re-engages after any fallback-driven tick, re-baseline exactly like
  // startAudio does (t0 = now, done = 0) instead of trusting the stale
  // ledger.
  let lastTickWasFallback = true;

  function tick(now: number): void {
    pollGamepad(emu);
    if (audioCtx && audioCtx.state === 'running' && beeper) {
      if (lastTickWasFallback) {
        audioT0 = audioCtx.currentTime;
        audioDone = 0;
        lastTickWasFallback = false;
      }
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
      // gesture yet) and while it's still resuming/suspended.
      lastTickWasFallback = true;
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
}

main().catch(showBootstrapError);

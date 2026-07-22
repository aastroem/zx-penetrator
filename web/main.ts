import { Emu } from './emu';
import { Screen } from './gl';
import { attachKeyboard } from './input';

const emu = await Emu.create();
emu.boot();

const scr = new Screen(document.getElementById('screen') as HTMLCanvasElement);
attachKeyboard(emu);
addEventListener('resize', () => scr.resize());
scr.resize();

let last = performance.now();
function tick(now: number): void {
  const owed = Math.min(4, Math.round((now - last) / 20)); // 50Hz frames
  if (owed > 0) {
    emu.runFrames(owed);
    last += owed * 20;
  } else if (now - last > 1000) {
    last = now; // tab was parked
  }
  scr.draw(emu.screen(), emu.border(), emu.frame());
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

import { readFile } from 'node:fs/promises';
const bytes = await readFile('web/public/pen.wasm');
const stubs = new Proxy({}, { get: () => () => 0 });
const { instance } = await WebAssembly.instantiate(bytes,
  { wasi_snapshot_preview1: stubs });
const e = instance.exports;
e.pen_boot();
e.pen_run_frames(300);
const hash = (e.pen_hash() >>> 0).toString(16).padStart(8, '0');
const golden = (await readFile('test/golden/boot300.hash', 'utf8')).trim();
if (hash !== golden) { console.error(`WASM ${hash} != golden ${golden}`); process.exit(1); }
console.log('wasm-smoke: boot300 MATCH');

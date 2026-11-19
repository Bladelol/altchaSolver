// Worker: hält eine Instanz des WASM-Moduls und rechnet zugeteilte Chunks.
import type { ToWorker, FromWorker } from './protocol.js';

interface SolverExports {
  memory: WebAssembly.Memory;
  saltPtr(): number;
  targetPtr(): number;
  setup(len: number): void;
  search(start: bigint, count: number): bigint;
}

const ctx = self as unknown as {
  postMessage(msg: FromWorker): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
};

let wasm: SolverExports | undefined;
let job = -1;

ctx.onmessage = async (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      const inst = await WebAssembly.instantiate(msg.module, { env: { abort() { throw new Error('wasm abort'); } } });
      wasm = inst.exports as unknown as SolverExports;
      ctx.postMessage({ type: 'ready' });
      break;
    }
    case 'job': {
      const w = wasm!;
      const mem = new Uint8Array(w.memory.buffer);
      mem.set(msg.salt, w.saltPtr());
      mem.set(msg.target, w.targetPtr());
      w.setup(msg.salt.length);
      job = msg.id;
      break;
    }
    case 'chunk': {
      // Veraltete Chunks (Job schon gelöst/abgebrochen) sofort quittieren.
      const found = msg.id === job ? Number(wasm!.search(BigInt(msg.start), msg.count)) : -1;
      ctx.postMessage({ type: 'done', id: msg.id, found });
      break;
    }
  }
};

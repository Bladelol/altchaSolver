// ALTCHA-Solver (SHA-512) – WASM-SIMD + Worker-Pool, ohne Laufzeit-Abhängigkeiten.
import type { ToWorker, FromWorker } from './protocol.js';

export interface Solution {
  number: number;
  /** Rechenzeit in ms */
  took: number;
}

export interface SolverOptions {
  /** Anzahl Worker (Standard: navigator.hardwareConcurrency) */
  workers?: number;
  /** URL der solver.wasm (Standard: neben diesem Modul) */
  wasmUrl?: string | URL;
  /** URL des Worker-Skripts (Standard: neben diesem Modul) */
  workerUrl?: string | URL;
}

export interface Solver {
  /** Erfüllt, sobald Modul kompiliert und alle Worker bereit sind. */
  ready: Promise<void>;
  /**
   * Sucht n in [0, maxnumber] mit SHA512(salt + n) == challenge.
   * Gesucht wird zuerst ab maxnumber/2 aufwärts, danach (falls nötig) der Rest darunter.
   */
  solve(challenge: string, salt: string, maxnumber: number, opts?: { signal?: AbortSignal }): Promise<Solution>;
  destroy(): void;
}

const IN_FLIGHT = 2; // Chunks pro Worker gleichzeitig -> kein Leerlauf durch Nachrichten-Roundtrip

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) throw new Error('challenge muss ein SHA-512-Hex-Hash (128 Zeichen) sein');
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function sha512Hex(text: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-512', enc.encode(text)));
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Zerlegt [from, end) in Chunks (from, end Vielfache von 10): Start und Länge Vielfache von 10, nie über eine Zehnerpotenz. */
function* range(from: number, end: number, size: number): Generator<[number, number]> {
  let pow = 10;
  for (let s = from; s < end; ) {
    while (pow <= s) pow *= 10;
    const e = Math.min(s + size, pow, end);
    yield [s, e - s];
    s = e;
  }
}

/** Erst [max/2, max], danach [0, max/2) – jeweils auf Zehner gerundet. */
function* chunks(max: number, size: number): Generator<[number, number]> {
  const end = Math.ceil((max + 1) / 10) * 10;
  const mid = Math.floor(max / 2 / 10) * 10;
  yield* range(mid, end, size);
  yield* range(0, mid, size);
}

export function createSolver(options: SolverOptions = {}): Solver {
  const count = Math.max(1, options.workers ?? navigator.hardwareConcurrency ?? 4);
  const wasmUrl = options.wasmUrl ?? new URL('./solver.wasm', import.meta.url);
  const workerUrl = options.workerUrl ?? new URL('./altcha-worker.mjs', import.meta.url);

  const workers: Worker[] = [];
  let onDone: ((w: Worker, id: number, found: number) => void) | null = null;

  const ready = (async () => {
    const res = fetch(wasmUrl);
    const module = await WebAssembly.compileStreaming(res).catch(async () =>
      WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()));
    await Promise.all(Array.from({ length: count }, () => new Promise<void>((resolve, reject) => {
      const w = new Worker(workerUrl, { type: 'module' });
      w.onerror = (e) => reject(new Error(`Worker-Fehler: ${e.message}`));
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'ready') resolve();
        else onDone?.(w, m.id, m.found);
      };
      w.postMessage({ type: 'init', module } satisfies ToWorker);
      workers.push(w);
    })));
  })();

  let nextId = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function run(challenge: string, saltStr: string, max: number, signal?: AbortSignal): Promise<Solution> {
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('maxnumber muss eine ganze Zahl >= 0 sein');
    const salt = enc.encode(saltStr);
    if (salt.length > 4096) throw new Error('Salt zu lang (max. 4096 Bytes)');
    const target = hexToBytes(challenge);
    const expected = challenge.toLowerCase();

    await ready;
    signal?.throwIfAborted();
    const id = ++nextId;
    const t0 = performance.now();
    // Chunk-Größe: genug Arbeit pro Nachricht, aber feine Verteilung bei kleinem max.
    const size = Math.min(100_000, Math.max(1_000, Math.ceil(max / (count * 16) / 10) * 10));
    const gen = chunks(max, size);

    for (const w of workers) w.postMessage({ type: 'job', id, salt, target } satisfies ToWorker);

    return new Promise<Solution>((resolve, reject) => {
      let pending = 0;
      let finished = false;

      const send = (w: Worker) => {
        const c = gen.next();
        if (c.done) return;
        pending++;
        w.postMessage({ type: 'chunk', id, start: c.value[0], count: c.value[1] } satisfies ToWorker);
      };
      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        onDone = null;
        nextId++; // macht noch laufende Chunks dieses Jobs veraltet
        signal?.removeEventListener('abort', abort);
        fn();
      };
      const abort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener('abort', abort);

      onDone = (w, jobId, found) => {
        if (jobId !== id || finished) return;
        pending--;
        if (found >= 0) {
          // Endgültige Prüfung (Kern vergleicht nur 64 Bit des Hashes).
          pending++;
          sha512Hex(saltStr + found).then((h) => {
            pending--;
            if (h === expected) {
              const took = Math.round(performance.now() - t0);
              finish(() => resolve({ number: found, took }));
            } else if (pending === 0) {
              finish(() => reject(new Error('Keine Lösung gefunden')));
            }
          });
        }
        send(w);
        if (pending === 0) finish(() => reject(new Error('Keine Lösung gefunden')));
      };

      for (let i = 0; i < IN_FLIGHT; i++) for (const w of workers) send(w);
    });
  }

  return {
    ready,
    solve(challenge, salt, maxnumber, opts) {
      const p = queue.then(() => run(challenge, salt, maxnumber, opts?.signal));
      queue = p.catch(() => {});
      return p;
    },
    destroy() {
      for (const w of workers) w.terminate();
      workers.length = 0;
    },
  };
}

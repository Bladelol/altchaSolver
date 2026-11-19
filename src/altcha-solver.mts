// ALTCHA-Solver (SHA-512) – WASM-SIMD + Worker-Pool, ohne Laufzeit-Abhängigkeiten.
import type { ToWorker, FromWorker } from './protocol.js';

export interface Challenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature?: string;
  maxnumber?: number;
  maxNumber?: number;
}

export interface Solution {
  number: number;
  /** Rechenzeit in ms */
  took: number;
  /** Fertiger ALTCHA-Payload (Base64-JSON) für das Formularfeld bzw. den Server */
  payload: string;
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
  solve(challenge: Challenge | string, opts?: { signal?: AbortSignal }): Promise<Solution>;
  destroy(): void;
}

const DEFAULT_MAX = 1_000_000;
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

/** Zerlegt [0, max] in Chunks: Start und Länge Vielfache von 10, nie über eine Zehnerpotenz. */
function* chunks(max: number, size: number): Generator<[number, number]> {
  const end = Math.ceil((max + 1) / 10) * 10;
  let pow = 10;
  for (let s = 0; s < end; ) {
    while (pow <= s) pow *= 10;
    const e = Math.min(s + size, pow, end);
    yield [s, e - s];
    s = e;
  }
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

  async function run(input: Challenge | string, signal?: AbortSignal): Promise<Solution> {
    const ch: Challenge = typeof input === 'string' ? JSON.parse(input) : input;
    if (ch.algorithm.toUpperCase() !== 'SHA-512') throw new Error(`Nur SHA-512 unterstützt, nicht ${ch.algorithm}`);
    const max = ch.maxnumber ?? ch.maxNumber ?? DEFAULT_MAX;
    const salt = enc.encode(ch.salt);
    if (salt.length > 4096) throw new Error('Salt zu lang (max. 4096 Bytes)');
    const target = hexToBytes(ch.challenge);
    const expected = ch.challenge.toLowerCase();

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
          sha512Hex(ch.salt + found).then((h) => {
            pending--;
            if (h === expected) {
              const took = Math.round(performance.now() - t0);
              const payload = btoa(JSON.stringify({
                algorithm: ch.algorithm, challenge: ch.challenge, number: found,
                salt: ch.salt, signature: ch.signature, took,
              }));
              finish(() => resolve({ number: found, took, payload }));
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
    solve(challenge, opts) {
      const p = queue.then(() => run(challenge, opts?.signal));
      queue = p.catch(() => {});
      return p;
    },
    destroy() {
      for (const w of workers) w.terminate();
      workers.length = 0;
    },
  };
}

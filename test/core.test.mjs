// Prüft den WASM-Kern gegen node:crypto (nur Testzeit, keine Abhängigkeit).
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const bytes = readFileSync(new URL('../dist/solver.wasm', import.meta.url));
const { instance: { exports: wasm } } = await WebAssembly.instantiate(bytes, { env: { abort() { throw new Error('abort'); } } });
const enc = new TextEncoder();

function prepare(salt, targetHex) {
  const s = enc.encode(salt);
  const mem = new Uint8Array(wasm.memory.buffer);
  mem.set(s, wasm.saltPtr());
  for (let i = 0; i < 64; i++) mem[wasm.targetPtr() + i] = parseInt(targetHex.substr(i * 2, 2), 16);
  wasm.setup(s.length);
}

// Gleiche Aufteilung wie im Browser: Vielfache von 10, nie über eine Zehnerpotenz hinweg.
function solve(max, chunk = 10_000) {
  const end = Math.ceil((max + 1) / 10) * 10;
  for (let s = 0; s < end; ) {
    let pow = 10;
    while (pow <= s) pow *= 10;
    const e = Math.min(s + chunk, pow, end);
    const r = wasm.search(BigInt(s), e - s);
    if (r >= 0n) return Number(r);
    s = e;
  }
  return -1;
}

const sha = (s) => createHash('sha512').update(s).digest('hex');
let fails = 0, runs = 0;
function check(salt, n, max) {
  prepare(salt, sha(salt + n));
  const got = solve(max);
  runs++;
  if (got !== n) { fails++; console.error(`FEHLER saltLen=${salt.length} n=${n}: bekam ${got}`); }
}

const saltOf = (len) => randomBytes(len).toString('hex').slice(0, len);
// Alle Salt-Längen, die Block- und Wortgrenzen berühren, mit Zahlen verschiedener Stellenzahl.
for (let len = 0; len <= 300; len++) {
  for (const n of [0, 1, 9, 10, 11, 99, 100, 1234, 99999]) {
    if (len % 7 !== 0 && n > 100 && !(len >= 100 && len <= 140) && !(len >= 230 && len <= 260)) continue;
    check(saltOf(len), n, Math.max(n, 100));
  }
}
// Zufällige Fälle mit größeren Zahlen.
for (let i = 0; i < 20; i++) {
  const n = Math.floor(Math.random() * 300_000);
  check(saltOf(Math.floor(Math.random() * 200)), n, 300_000);
}
// Nicht lösbar -> -1
prepare('abc', sha('nope'));
runs++; if (solve(1000) !== -1) { fails++; console.error('FEHLER: falscher Treffer'); }

// Mini-Benchmark: 1 Thread
const salt = saltOf(43);
prepare(salt, sha('x'));
const N = 2_000_000, t0 = performance.now();
solve(N, 50_000);
const dt = (performance.now() - t0) / 1000;
console.log(`${runs - fails}/${runs} ok · ${(N / dt / 1e6).toFixed(2)} Mio. Hashes/s (1 Thread, Node)`);
process.exit(fails ? 1 : 0);

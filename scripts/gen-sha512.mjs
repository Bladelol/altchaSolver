// Erzeugt assembly/sha512.generated.ts: vollständig ausgerollte SHA-512-Kompression
// auf i64x2 (zwei Kandidaten pro Durchlauf). Keine Laufzeit-Abhängigkeiten.
import { writeFileSync } from 'node:fs';

const K = [
  '0x428a2f98d728ae22', '0x7137449123ef65cd', '0xb5c0fbcfec4d3b2f', '0xe9b5dba58189dbbc',
  '0x3956c25bf348b538', '0x59f111f1b605d019', '0x923f82a4af194f9b', '0xab1c5ed5da6d8118',
  '0xd807aa98a3030242', '0x12835b0145706fbe', '0x243185be4ee4b28c', '0x550c7dc3d5ffb4e2',
  '0x72be5d74f27b896f', '0x80deb1fe3b1696b1', '0x9bdc06a725c71235', '0xc19bf174cf692694',
  '0xe49b69c19ef14ad2', '0xefbe4786384f25e3', '0x0fc19dc68b8cd5b5', '0x240ca1cc77ac9c65',
  '0x2de92c6f592b0275', '0x4a7484aa6ea6e483', '0x5cb0a9dcbd41fbd4', '0x76f988da831153b5',
  '0x983e5152ee66dfab', '0xa831c66d2db43210', '0xb00327c898fb213f', '0xbf597fc7beef0ee4',
  '0xc6e00bf33da88fc2', '0xd5a79147930aa725', '0x06ca6351e003826f', '0x142929670a0e6e70',
  '0x27b70a8546d22ffc', '0x2e1b21385c26c926', '0x4d2c6dfc5ac42aed', '0x53380d139d95b3df',
  '0x650a73548baf63de', '0x766a0abb3c77b2a8', '0x81c2c92e47edaee6', '0x92722c851482353b',
  '0xa2bfe8a14cf10364', '0xa81a664bbc423001', '0xc24b8b70d0f89791', '0xc76c51a30654be30',
  '0xd192e819d6ef5218', '0xd69906245565a910', '0xf40e35855771202a', '0x106aa07032bbd1b8',
  '0x19a4c116b8d2d0c8', '0x1e376c085141ab53', '0x2748774cdf8eeb99', '0x34b0bcb5e19b48a8',
  '0x391c0cb3c5c95a63', '0x4ed8aa4ae3418acb', '0x5b9cca4f7763e373', '0x682e6ff3d6b2b8a3',
  '0x748f82ee5defb2fc', '0x78a5636f43172f60', '0x84c87814a1f0ab72', '0x8cc702081a6439ec',
  '0x90befffa23631e28', '0xa4506cebde82bde9', '0xbef9a3f7b2c67915', '0xc67178f2e372532b',
  '0xca273eceea26619c', '0xd186b8c721c0c207', '0xeada7dd6cde0eb1e', '0xf57d4f7fee6ed178',
  '0x06f067aa72176fba', '0x0a637dc5a2c898a6', '0x113f9804bef90dae', '0x1b710b35131c471b',
  '0x28db77f523047d84', '0x32caab7b40c72493', '0x3c9ebe0a15c9bebc', '0x431d67c49c100d4c',
  '0x4cc5d4becb3e42b6', '0x597f299cfc657e2a', '0x5fcb6fab3ad6faec', '0x6c44198c4a475817',
];

const V = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const rotr = (x, n) => `v128.or(i64x2.shr_u(${x}, ${n}), i64x2.shl(${x}, ${64 - n}))`;
const xor3 = (p, q, r) => `v128.xor(v128.xor(${p}, ${q}), ${r})`;

function schedule(i) {
  const w = (j) => `w${j & 15}`;
  return `  ${w(i)} = i64x2.add(i64x2.add(${w(i)}, ${w(i - 7)}), i64x2.add(` +
    `${xor3(rotr(w(i - 2), 19), rotr(w(i - 2), 61), `i64x2.shr_u(${w(i - 2)}, 6)`)}, ` +
    `${xor3(rotr(w(i - 15), 1), rotr(w(i - 15), 8), `i64x2.shr_u(${w(i - 15)}, 7)`)}));`;
}

// Feste Variablennamen + Verschieben: In SSA (TurboFan) sind die Zuweisungen kostenlos,
// und Einsprung bei Runde k per switch-Fallthrough funktioniert ohne Umbenennung.
function round(i) {
  const lines = [];
  if (i >= 16) lines.push(schedule(i));
  lines.push(
    `  t1 = i64x2.add(i64x2.add(h, ${xor3(rotr('e', 14), rotr('e', 18), rotr('e', 41))}), ` +
      `i64x2.add(i64x2.add(v128.bitselect(f, g, e), i64x2.splat(<i64>${K[i]})), w${i & 15}));`,
    `  t2 = i64x2.add(${xor3(rotr('a', 28), rotr('a', 34), rotr('a', 39))}, v128.bitselect(b, a, v128.xor(a, c)));`,
    `  h = g; g = f; f = e; e = i64x2.add(d, t1); d = c; c = b; b = a; a = i64x2.add(t1, t2);`,
  );
  return lines.join('\n');
}

const loadW = Array.from({ length: 16 }, (_, j) => `  let w${j} = v128.load(wPtr, ${j * 16});`).join('\n');
const loadS = (ptr) => V.map((v, j) => `  let ${v} = v128.load(${ptr}, ${j * 16});`).join('\n');

let out = `// AUTOMATISCH ERZEUGT von scripts/gen-sha512.mjs – nicht von Hand bearbeiten.
// Speicherformat: jedes 64-Bit-Wort als v128 (i64x2, Lane 0/1 = zwei Kandidaten),
// Nachrichtenwörter bereits als Big-Endian-Wert (also Zahl, nicht Byte-Reihenfolge).

/**
 * Ein Block. Startzustand bei prePtr = Zustand NACH k Runden (0 <= k <= 15).
 * basePtr = Zustand vor dem Block (für die Feed-Forward-Addition).
 * last = 0: alle 80 Runden, Ergebnis (base + state) nach outPtr, Rückgabe 0.
 * last = 1: nur 77 Runden; vergleicht H3 = base3 + a77 mit v128 bei tPtr,
 *           Rückgabe Lane-Bitmaske (bit0 = Lane 0, bit1 = Lane 1).
 */
export function block(wPtr: usize, prePtr: usize, basePtr: usize, outPtr: usize, tPtr: usize, k: i32, last: i32): i32 {
${loadW}
${loadS('prePtr')}
  let t1: v128, t2: v128;
  switch (k) {
`;
for (let i = 0; i < 16; i++) out += `    case ${i}: {\n${round(i).replace(/^/gm, '    ')}\n    }\n`;
out += `  }\n`;
for (let i = 16; i < 77; i++) out += round(i) + '\n';
out += `  if (last) {
    return i64x2.bitmask(i64x2.eq(i64x2.add(v128.load(basePtr, 48), a), v128.load(tPtr)));
  }
`;
for (let i = 77; i < 80; i++) out += round(i) + '\n';
out += V.map((v, j) => `  v128.store(outPtr, i64x2.add(v128.load(basePtr, ${j * 16}), ${v}), ${j * 16});`).join('\n');
out += `\n  return 0;\n}\n\n`;

out += `/** Führt nur die Runden 0..k-1 aus (Zustand bei statePtr) und speichert nach outPtr. */
export function prefixRounds(wPtr: usize, statePtr: usize, outPtr: usize, k: i32): void {
${loadW}
${loadS('statePtr')}
  let t1: v128, t2: v128;
`;
for (let i = 0; i < 16; i++) {
  out += `  if (k == ${i}) {\n${V.map((v, j) => `    v128.store(outPtr, ${v}, ${j * 16});`).join('\n')}\n    return;\n  }\n`;
  out += round(i) + '\n';
}
out += V.map((v, j) => `  v128.store(outPtr, ${v}, ${j * 16});`).join('\n') + '\n}\n';

writeFileSync(new URL('../assembly/sha512.generated.ts', import.meta.url), out);
console.log('assembly/sha512.generated.ts erzeugt');

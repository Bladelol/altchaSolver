// ALTCHA-Solver (SHA-512): sucht n mit SHA512(salt + dezimal(n)) == target.
// Ein Modul, nur SIMD: zwei Kandidaten (n, n+1) pro Kompressionsaufruf.
import { block, prefixRounds } from './sha512.generated';

export const MAX_SALT: i32 = 4096;

// Statische Puffer (keine Allokation, keine GC).
const SALT = memory.data(MAX_SALT, 16); // Salt-Bytes (schreibt JS)
const TRAW = memory.data(64, 16);       // Ziel-Hash, 64 Rohbytes (schreibt JS)
const MSG = memory.data(256, 16);       // Ende der Nachricht: Salt-Rest, Ziffern, Padding (max. 2 Blöcke)
const W0 = memory.data(256, 16);        // Block 0 als 16 x v128
const W1 = memory.data(256, 16);        // Block 1 als 16 x v128
const MID = memory.data(128, 16);       // Midstate nach vollen Salt-Blöcken
const PRE = memory.data(128, 16);       // Midstate + konstante Anfangsrunden von Block 0
const S1 = memory.data(128, 16);        // Zustand nach Block 0 (2-Block-Fall)
const OUT = memory.data(128, 16);       // Scratch
const TGT = memory.data(16, 16);        // H3 des Ziels, gesplattet
const DV = memory.data(80, 16);         // 5 Ziffernpaare (0/1, 2/3, ...) an der Byteposition der letzten Ziffer

let saltLen: i32 = 0;
let rem: i32 = 0; // Salt-Bytes im ersten nicht-vollständigen Block

export function saltPtr(): usize { return SALT; }
export function targetPtr(): usize { return TRAW; }

@inline function wordsFrom(src: usize, dst: usize, from: i32, to: i32): void {
  for (let i = from; i <= to; i++) {
    v128.store(dst + (<usize>i << 4), i64x2.splat(<i64>bswap<u64>(load<u64>(src + (<usize>i << 3)))));
  }
}

/** Nach dem Schreiben von Salt und Ziel aufrufen. Komprimiert volle Salt-Blöcke vorab. */
export function setup(len: i32): void {
  saltLen = len;
  rem = len & 127;
  v128.store(MID, i64x2.splat(<i64>0x6a09e667f3bcc908), 0);
  v128.store(MID, i64x2.splat(<i64>0xbb67ae8584caa73b), 16);
  v128.store(MID, i64x2.splat(<i64>0x3c6ef372fe94f82b), 32);
  v128.store(MID, i64x2.splat(<i64>0xa54ff53a5f1d36f1), 48);
  v128.store(MID, i64x2.splat(<i64>0x510e527fade682d1), 64);
  v128.store(MID, i64x2.splat(<i64>0x9b05688c2b3e6c1f), 80);
  v128.store(MID, i64x2.splat(<i64>0x1f83d9abfb41bd6b), 96);
  v128.store(MID, i64x2.splat(<i64>0x5be0cd19137e2179), 112);
  const full = len >> 7;
  for (let b = 0; b < full; b++) {
    wordsFrom(SALT + (<usize>b << 7), W0, 0, 15);
    block(W0, MID, MID, MID, TGT, 0, 0);
  }
  v128.store(TGT, i64x2.splat(<i64>bswap<u64>(load<u64>(TRAW + 24))));
}

function digitCount(n: u64): i32 {
  let d = 1;
  while (n >= 10) { n /= 10; d++; }
  return d;
}

/**
 * Durchsucht [start, start + count). Voraussetzungen (sichert JS):
 * start % 10 == 0, count % 10 == 0, alle Zahlen haben dieselbe Stellenzahl.
 * Rückgabe: gefundenes n oder -1.
 */
export function search(start: u64, count: u32): i64 {
  const d = digitCount(start);
  const r = rem;
  const lp = r + d - 1;                // Byteposition der letzten Ziffer
  const nb = r + d + 17 <= 128 ? 1 : 2; // Anzahl Blöcke im Nachrichtenende
  const k = r >> 3;                    // Wörter, die nur aus Salt bestehen

  memory.fill(MSG, 0, 256);
  memory.copy(MSG, SALT + <usize>(saltLen - r), <usize>r);
  let q0 = start / 10;
  for (let p = lp - 1, q = q0; p >= r; p--, q /= 10) {
    store<u8>(MSG + <usize>p, <u8>(48 + <i32>(q % 10)));
  }
  store<u8>(MSG + <usize>(lp + 1), 0x80);
  store<u64>(MSG + <usize>(nb * 128 - 8), bswap<u64>(<u64>(saltLen + d) << 3));

  wordsFrom(MSG, W0, 0, 15);
  if (nb == 2) wordsFrom(MSG + 128, W1, 0, 15);
  prefixRounds(W0, MID, PRE, k);

  const wl = lp >> 3;
  const shift = <i64>((7 - (lp & 7)) << 3);
  const wbase: usize = wl < 16 ? W0 + (<usize>wl << 4) : W1 + (<usize>(wl - 16) << 4);
  for (let j = 0; j < 5; j++) {
    const lo = <i64>(48 + 2 * j) << shift;
    v128.store(DV + (<usize>j << 4), i64x2.replace_lane(i64x2.splat(lo), 1, <i64>(49 + 2 * j) << shift));
  }

  const qEnd = q0 + <u64>(count / 10);
  for (let q = q0; q < qEnd; q++) {
    // Nur die Wörter mit Ziffern neu aufbauen (Wort-Indizes k..wl über beide Blöcke).
    for (let i = k; i <= wl; i++) {
      const dst: usize = i < 16 ? W0 + (<usize>i << 4) : W1 + (<usize>(i - 16) << 4);
      v128.store(dst, i64x2.splat(<i64>bswap<u64>(load<u64>(MSG + (<usize>i << 3)))));
    }
    const baseV = v128.load(wbase);
    for (let j = 0; j < 5; j++) {
      v128.store(wbase, v128.or(baseV, v128.load(DV + (<usize>j << 4))));
      let m: i32;
      if (nb == 1) {
        m = block(W0, PRE, MID, OUT, TGT, k, 1);
      } else {
        block(W0, PRE, MID, S1, TGT, k, 0);
        m = block(W1, S1, S1, OUT, TGT, 0, 1);
      }
      if (m) return <i64>(q * 10 + <u64>(2 * j + ((m & 1) ? 0 : 1)));
    }
    // Präfix-Ziffern (ASCII) um eins erhöhen.
    for (let p = lp - 1; p >= r; p--) {
      const c = load<u8>(MSG + <usize>p);
      if (c == 57) { store<u8>(MSG + <usize>p, 48); }
      else { store<u8>(MSG + <usize>p, c + 1); break; }
    }
  }
  return -1;
}

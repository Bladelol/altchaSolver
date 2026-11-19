# altcha-solver

ALTCHA-Löser (v1, SHA-512) für den Browser: WASM-SIMD (`i64x2`, 2 Kandidaten pro Kompression) + Worker-Pool.
Keine Laufzeit-Abhängigkeiten; `assemblyscript` und `typescript` nur zum Bauen.

Gesucht wird `n` in `[0, maxnumber]` mit `SHA512(salt + String(n)) == challenge`.

## 🚀 How to start

In drei Schritten: bauen, drei Dateien kopieren, eine Methode aufrufen.

### 1. Bauen

```sh
npm install
npm run build
```

Danach liegt alles Nötige in `dist/`.

### 2. Dateien in die Webapp kopieren

Diese drei Dateien aus `dist/` kommen **gemeinsam in einen Ordner**, den deine Webapp statisch ausliefert
(z. B. `public/altcha/`):

```
public/altcha/
├── altcha-solver.mjs   ← Einstiegspunkt mit der API (das importierst du)
├── altcha-worker.mjs   ← wird von altcha-solver.mjs automatisch als Worker gestartet
└── solver.wasm         ← wird von altcha-solver.mjs automatisch geladen
```

Optional für TypeScript-Projekte: `altcha-solver.d.mts` (Typen) daneben legen.
`protocol.js` und die übrigen `.d.*ts`-Dateien enthalten nur Typen und werden zur Laufzeit nicht gebraucht.

> **Wichtig:** Alle drei im selben Ordner und auf derselben Domain wie die Seite –
> `altcha-solver.mjs` lädt Worker und WASM relativ zu sich selbst.

### 3. Methode aufrufen

```js
import { createSolver } from '/altcha/altcha-solver.mjs';

// Einmal beim Laden der Seite: WASM kompilieren + Worker starten (~50–100 ms)
const solver = createSolver();

// Wann immer gelöst werden soll:
async function getAltchaPayload() {
  const challenge = await fetch('/api/altcha/challenge').then((r) => r.json());
  const { payload } = await solver.solve(challenge);
  return payload; // Base64-String → an den Server schicken
}
```

Den `payload` schickst du an deinen Server (z. B. als Formularfeld `altcha` oder als Header),
der ihn wie gewohnt verifiziert (z. B. `verifySolution`).

### Erwartetes Challenge-Format (ALTCHA v1)

```json
{
  "algorithm": "SHA-512",
  "challenge": "<128 Hex-Zeichen>",
  "salt": "…",
  "maxnumber": 1000000,
  "signature": "…"
}
```

`solve()` nimmt das als Objekt oder als JSON-String. Fehlt `maxnumber`, gilt `1000000`.

### API

| Aufruf | Beschreibung |
|---|---|
| `createSolver(options?)` | Erstellt den Pool. `options.workers` (Standard: `navigator.hardwareConcurrency`, sonst 4), `options.wasmUrl`, `options.workerUrl` |
| `solver.ready` | Promise: erfüllt, sobald WASM kompiliert und alle Worker bereit sind |
| `solver.solve(challenge, { signal? })` | Liefert `{ number, took, payload }`; abbrechbar per `AbortController` |
| `solver.destroy()` | Beendet alle Worker |

### ✅ Checkliste

- [ ] **CSP:** Falls vorhanden, braucht sie `script-src 'wasm-unsafe-eval'` und `worker-src 'self'`
      (kein `blob:` nötig).
- [ ] **MIME-Typ `.mjs`:** beide `.mjs` müssen als `text/javascript` ausgeliefert werden – sonst lehnt der Browser das Modul ab.
      Gängige Server (nginx, Apache, Caddy, Express, …) tun das bereits.
- [ ] **MIME-Typ `.wasm`:** idealerweise `application/wasm`
      (sonst funktioniert es trotzdem, nur über einen etwas langsameren Ladeweg).
- [ ] **Bundler (Vite, Webpack 5, …):** Am robustesten über `public/` einbinden, damit der Bundler die Dateien
      nicht anfasst. Liegt `solver.wasm` woanders: `createSolver({ wasmUrl: '/pfad/solver.wasm' })`.
- [ ] **Browser:** alle mit WASM-SIMD – Chrome/Edge 91+, Firefox 89+, Safari 16.4+.

### 💡 Tipps

- **Früh erstellen:** `createSolver()` beim Seitenladen aufrufen, dann kostet `solve()` nur noch die reine Rechenzeit.
  Untätige Worker verbrauchen keine CPU.
- **Nur selten gebraucht?** `createSolver()` erst beim Lösen aufrufen und danach `solver.destroy()`.
- **Abbrechen:** `solver.solve(challenge, { signal: controller.signal })`.

## 🛠️ Entwicklung

```sh
npm test        # WASM-Kern gegen node:crypto testen
npm run serve   # Testseite: http://localhost:8080/bench/  (nicht per file:// öffnen)
```

## Dateien

| Datei | Aufgabe |
|---|---|
| `scripts/gen-sha512.mjs` | Generator für die SHA-512-Kompression. Schreibt `assembly/sha512.generated.ts`: alle 80 Runden ausgerollt, nur lokale `v128`-Variablen, Einsprung bei Runde `k` per `switch`, Vergleich von `H3` nach Runde 77. |
| `assembly/sha512.generated.ts` | *Build-Ergebnis, nicht im Git.* Exportiert `block()` (ein Block, optional mit frühem Vergleich) und `prefixRounds()` (nur die Runden `0..k-1`). |
| `assembly/index.ts` | Kern im WASM: statische Puffer, `setup()` (Midstate über volle Salt-Blöcke, Ziel-Wort), `search(start, count)` (baut Nachrichtenende mit ASCII-Ziffern, zählt in-place hoch, ruft `block()` für Paare `n`/`n+1`). |
| `src/altcha-solver.mts` | Öffentliche API für den Browser: kompiliert `solver.wasm`, startet den Worker-Pool, zerlegt `[0, maxnumber]` in Chunks, verteilt sie, prüft Treffer per `crypto.subtle` und baut den Base64-Payload. |
| `src/altcha-worker.mts` | Worker: instanziiert das übergebene Modul einmal, schreibt Salt/Ziel in den WASM-Speicher, rechnet Chunks und meldet `found` (oder `-1`). |
| `src/protocol.ts` | Nachrichtentypen zwischen Hauptthread und Worker (`init`, `job`, `chunk`, `ready`, `done`). |
| `test/core.test.mjs` | Testet den WASM-Kern in Node gegen `node:crypto` (alle Salt-Längen 0–300, Stellenwechsel, unlösbar) + Mini-Benchmark. |
| `bench/index.html` | Testseite im Browser: zufällige Challenges lösen, Durchsatz messen, Worker-Anzahl wählen. |
| `scripts/serve.mjs` | Statischer Dev-Server ohne Abhängigkeiten (richtiger MIME-Typ für `.wasm`). |
| `tsconfig.json` / `package.json` | Build-Konfiguration (`tsc` für `src/`, `asc` für `assembly/`). |

## Zusammenspiel

### Build

```
scripts/gen-sha512.mjs ──► assembly/sha512.generated.ts ─┐
                                                         ├─ asc -O3 --enable simd ──► dist/solver.wasm
                           assembly/index.ts ────────────┘
src/*.mts ──────────────────────────── tsc ─────────────────► dist/altcha-solver.mjs, dist/altcha-worker.mjs
```

### Laufzeit

```
 Hauptthread (altcha-solver.mjs)                         Worker 1..N (altcha-worker.mjs + wasm)
 ─────────────────────────                               ──────────────────────────────────────────
 createSolver()
   compileStreaming(solver.wasm) ── Module ─ init ────►   instantiate(Module)  (einmal pro Worker)
                                 ◄──────────── ready ──
 solve(challenge)
   salt, target (64 Bytes) ──────────────── job ─────►   Salt/Ziel in WASM-Speicher, setup()
                                                           └─ Midstate über volle Salt-Blöcke
   Chunks [s, s+size) aufsteigend,
   2 pro Worker gleichzeitig ────────────── chunk ───►   search(s, size)
                                 ◄──────── done(-1) ──     └─ kein Treffer
   nächsten Chunk nachschieben ──────────── chunk ───►   search(...)
                                 ◄──────── done(n) ───     └─ Treffer (64-Bit-Vergleich)
   crypto.subtle: SHA512(salt+n) == challenge?
   ja → { number, took, payload }; Job-ID erhöhen, Rest-Chunks werden ignoriert
```

Chunks haben Start und Länge als Vielfache von 10 und gehen nie über eine Zehnerpotenz
(so haben alle Zahlen eines Chunks dieselbe Stellenzahl).

### Im WASM-Kern (`search`)

```
Salt: [ volle 128-Byte-Blöcke ][ Rest r Bytes ]
            │ setup(): einmal komprimiert
            ▼
         Midstate (MID)

Nachrichtenende (1 oder 2 Blöcke, MSG):
  [ Salt-Rest | Präfix-Ziffern | letzte Ziffer | 0x80 | 0… | Länge in Bit ]
    Wörter 0..k-1           ▲            ▲
    nur Salt → Runden 0..k-1 einmal pro Chunk vorberechnet (PRE)
                            │            └─ pro Paar ersetzt: Lane 0 = '0','2',…  Lane 1 = '1','3',…
                            └─ pro 10 Zahlen ASCII +1 (mit Übertrag)

für jedes Paar (n, n+1):
  block(W0, PRE, ab Runde k) [→ block(W1) bei 2 Blöcken]
  nach Runde 77: H3 = base3 + a77 == Ziel-H3 ?  (Runden 78–80 entfallen)
     └─ ja → n bzw. n+1 zurückgeben
```

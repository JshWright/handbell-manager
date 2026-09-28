# Handbell Manager

Standalone macOS Electron app for handbell choir part assignment. Upload a MuseScore `.mscz` file, specify a player count, and get a conflict-free, pitch-adjacent assignment — no two players are ever asked to ring bells that overlap in time (or switch between bells faster than a configurable minimum gap). Each player can download a PDF of the full score with their bells color-highlighted.

## Running

```bash
npm start          # dev mode — opens a native Electron window
npm test           # tests for the parser, assigner, and bells-used strip
npm run make       # build a distributable .dmg in out/make/
```

First `npm start` downloads the Electron binary (~15s one-time). MuseScore 4 must be installed for PDF export; assignment and CSV export work without it.

## Architecture

Standard Electron split with a framework-free `core/` layer:

- **`src/core/`** — pure TypeScript, no Electron imports. Runs in the main process and is unit-testable with plain Node.
- **`src/main/main.ts`** — app lifecycle, `BrowserWindow`, all IPC handlers (`bell:openFile`, `bell:parse`, `bell:assign`, `bell:exportPdf`, `bell:exportAllPdf`, `bell:exportCsv`). Owns all filesystem work. `bell:exportAllPdf` renders every player's colored score (reusing the same per-player render/cache path as `exportPdf`, factored into the async `renderPlayerPdf`) and merges them into one PDF with `pdf-lib`. `renderPlayerPdf` also stamps a **"Bells Used" header** onto page 1 (unless the `bellsUsedHeader` spec flag is false): it builds a tiny separate strip score of that player's bells, renders it to a trimmed PNG, and composites it above the music (see `bells-used.ts` / `pdf-compose.ts`).
- **`src/preload/preload.ts`** — `contextBridge` exposing `window.bell.*` to the renderer (`openFile`, `pathForFile` via `webUtils` for drag-drop, `parse`, `assign`, `exportPdf`, `exportAllPdf`, `exportCsv`). `contextIsolation: true`, `nodeIntegration: false`.
- **`src/renderer/`** — single-window, single-page workspace; no framework. An empty/drop state, then a two-region layout: a left **setup rail** (file, ringer stepper, min-strikes, min-gap, and a scrollable bell list where pins live) and a right **live assignment** (stat strip + player-card grid). Every control triggers a debounced, race-safe `recompute()` (via `bell.assign`) — there is no submit step. Player names are edited inline on each card and deliberately do **not** recompute (they only relabel; the assignment math ignores them). Theme-aware (light/dark via `prefers-color-scheme`), brass/gold accent.

Session state lives in ordinary main-process variables: loaded `.mscz` bytes are cached in a `Map` keyed by file path; PDFs are cached per `(filePath, playerIdx)`.

## Core files

| File | What it does |
|------|--------------|
| `src/core/mscz-parser.ts` | Unzip (fflate) → XML walk (@xmldom/xmldom) → `NoteEvent[]`. Exposes `parseNotes`, `parseNotesWithElements`, `getDivision`, `notesByPitch`. |
| `src/core/assigner.ts` | `buildConflictGraph` (with optional `minGapTicks`), balanced-contiguous-partition DP, conflict repair, boundary perturbation, min-count bump, `assignPlayers`. Returns `Assignment`. |
| `src/core/pdf-color.ts` | `colorPlayerScore(msczBytes, noteNames)` — adds `<color>` tags to matching `<Note>` elements, rezips with fflate. Returns `{ mscz, orderedNames, colorByName }` so the header strip can reuse the exact same colors. `resolveBellColors(orderedNames, bellColors?)` maps each bell to an RGB (hex override, else auto HSV by pitch order). |
| `src/core/bells-used.ts` | `buildBellsUsedScore(orderedNames, colorByName)` — writes a minimal single-staff `.mscz`: one stemless colored notehead per bell, low→high, on one wide line. `nameToPitchTpc(name)` converts `"F#5"` → MuseScore `{ midi, tpc }`. |
| `src/core/rng.ts` | Mulberry32 seedable PRNG — `SeededRandom(seed)` with `.next()`, `.randint(n)`, `.choice(arr)`, `.shuffle(arr)`. |
| `src/main/mscore.ts` | `findMscoreBinary()` checks PATH then hardcoded candidates; `renderPdf(coloredMsczBytes)` spawns `mscore -o out.pdf in.mscz`, returns `PdfResult`. `renderTrimmedPng(msczBytes)` spawns `mscore --trim-image N -r DPI -o out.png` for the tightly-cropped header strip. |
| `src/main/pdf-compose.ts` | `addBellsUsedBand(pdfBytes, stripPng, bellCount)` — grows page 1 by a header band, redraws the original page below it, and draws the `Bells Used` / `N bells` caption + colored strip on top with `pdf-lib`. |
| `src/main/csv.ts` | `buildCsv(assignment)` → CSV string. |

## Key constraints and gotchas

**Preload path**: both `main.js` and `preload.js` compile to `.vite/build/`. The `BrowserWindow` preload must be `path.join(__dirname, 'preload.js')` — NOT `'../preload/preload.js'`.

**XML library choice**: `@xmldom/xmldom` (not `fast-xml-parser`) because PDF coloring needs surgical in-place mutation of specific `<Note>` DOM nodes and a faithful round-trip serialization. `XMLSerializer` is used to re-serialize the mutated document.

**Note naming**: MuseScore stores notes as `tpc` (tonal pitch class, −1..33) + `pitch` (MIDI number). `tpcToName` in `mscz-parser.ts` must use `((tpc - 14) % 7 + 7) % 7` (not bare `%`) to handle negative remainders correctly in JS.

**RNG determinism**: the assigner uses `SeededRandom(0)` by default, so results are repeatable. Most tests verify properties (conflict-free, all bells assigned, correct metrics, pins honored, error messages) rather than exact partitions.

**MuseScore PDF export**: `mscore -o out.pdf in.mscz`. Checked at export time, not on startup. On first run, macOS Gatekeeper may block MuseScore — approve once via System Settings → Privacy & Security → Open Anyway.

**"Bells Used" header — why composite, not in-score**: MuseScore 4's CLI does **not** render a manually-authored frame `<Image>` (injecting one into the title `VBox` is silently dropped), so the header can't be embedded in the score itself. Instead it's a second render: `buildBellsUsedScore` → `renderTrimmedPng` (a tightly-cropped strip) → `addBellsUsedBand` composites it onto the top of page 1 with `pdf-lib` (grow page height, redraw original below, draw caption + strip above). The strip is **always colored** (it's a color key), independent of the "Color notes" toggle, and reuses `colorByName` from `colorPlayerScore` so its colors match the score exactly. Costs one extra `mscore` invocation per player; strip failure falls back to the un-banded score.

**Packaging**: `npm run make` produces a `.dmg` (drag-to-Applications) on macOS; the ZIP/deb/rpm makers in `forge.config.ts` are Linux-only and Squirrel is Windows-only. Unsigned builds require recipients to right-click → Open once. Notarization requires an Apple Developer ID; wire in `@electron/notarize` if/when available.

## Tests

`test/core.test.mjs` compiles `src/core/` via esbuild in-memory and runs 28 checks:

- Parser: division, event count, every note and its timing vs. an independent oracle (`test/fixtures/generate-sample.mjs`), all 22 distinct note names, enharmonic merge
- Assigner: all bells assigned exactly once, conflict-freedom (no gap and 0.5-beat gap), pitchCost and spread at 10 players (fixed seed), pins honored, min-count floor met, two-hand splittability
- Error messages: too many players, negative gap, infeasible min-count
- Bells-used strip: `nameToPitchTpc` conversions, and a built strip round-trips through the parser (one note per bell, ascending order, every note colored and stemless)

`test/fixtures/Sample.mscz` is a small synthetic two-staff score (original music, no third-party content) generated by `test/fixtures/generate-sample.mjs`, which also exports the exact expected note events. After editing the music in that script, regenerate with `node test/fixtures/generate-sample.mjs` and update the baselines in the test.

Add a check whenever a new algorithm feature is added.

## Known limitations

- Repeats, D.S./D.C., codas, and volta brackets are not expanded — the score is read top to bottom.
- Tuplets are not handled — notes inside a tuplet are timed as if un-tupleted.
- Single-instrument scores only — multi-instrument scores merge all staves into one note pool.
- No persistence across launches.

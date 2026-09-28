# Handbell Manager

A desktop app for handbell choir directors. Load a [MuseScore](https://musescore.org) score, say how many ringers you have, and get a conflict-free, pitch-adjacent assignment of bells to players — no ringer is asked to ring overlapping notes with the same hand, or to switch bells faster than a gap you choose. Then export each ringer's part as a PDF of the full score with their bells highlighted.

## Features

- **Live assignment.** Every control recomputes instantly; there is no submit button.
- **Conflict-free assignments.** Within a hand, a ringer's bells never overlap in time, and you can require a minimum gap (in beats) between them. If your settings make that impossible, you get the best available assignment with the remaining conflicts marked.
- **Pitch-adjacent groupings.** Each ringer gets neighboring bells where possible.
- **Two-hand ringing.** Optionally allow two bells per ringer, one in each hand.
- **Minimum strikes.** Guarantee that no ringer falls below a given number of notes.
- **Pins.** Lock a specific bell to a specific ringer and let the rest rearrange around it.
- **Editable names and colors.** Rename ringers inline and pick a color for each bell.
- **Per-ringer PDFs.** Export the full score with a ringer's bells color-highlighted, optional ▲ markers on each of their notes, and a "Bells Used" header showing exactly which bells they ring. Export one ringer or everyone (merged into a single PDF).
- **CSV export** of the whole assignment: bell, hand, strike count, player totals and pins.

## Requirements

- macOS
- [Node.js](https://nodejs.org) and npm (to run from source)
- [MuseScore 4](https://musescore.org) for PDF export. Assignment and CSV export work without it.

## Getting started

```bash
npm install
npm start
```

Drop a `.mscz` file onto the window (or choose one), set the number of ringers, and adjust from there.

The repo includes a small synthetic score you can try: `test/fixtures/Sample.mscz`.

On first use, macOS Gatekeeper may block MuseScore's command-line tool. Approve it once under System Settings → Privacy & Security → Open Anyway.

## Building

```bash
npm run make
```

This produces a `.dmg` in `out/make/`. Builds are unsigned, so on first launch recipients need to right-click the app and choose Open.

## Tests

```bash
npm test
```

The tests cover the parser, the assignment algorithm, and the "Bells Used" strip, using the synthetic score in `test/fixtures/`.

## Limitations

- Repeats, D.S./D.C., codas and volta brackets are not expanded; the score is read top to bottom.
- Tuplets are not handled — notes inside a tuplet are timed as if they were not tupleted.
- Single-instrument scores work best; with several instruments, all staves are merged into one pool of notes.
- Nothing is saved between launches.

## License

[MIT](LICENSE)

Handbell Manager is an independent project and is not affiliated with or endorsed by MuseScore.

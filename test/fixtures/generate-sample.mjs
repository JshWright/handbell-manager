/**
 * Generates test/fixtures/Sample.mscz — a small, original two-staff score
 * (F major, 4/4 then a 3/4 coda) used by the tests — and exports the exact note
 * events it contains, so the parser can be checked against an independent oracle.
 *
 * The music is a compact DSL: each measure is a string of space-separated
 * tokens `PITCH[+PITCH...]:DUR`, where DUR is w/h/q/e/s (whole, half, quarter,
 * eighth, sixteenth) with an optional trailing `.` for a dotted value, and `r`
 * is a rest. It deliberately covers dotted rhythms, rests, dyads/triads, a
 * sixteenth-note run, a time-signature change, and a chromatic run whose A#4
 * shares a MIDI pitch with the (more common) Bb4, to exercise enharmonic merging.
 *
 * Regenerate after editing the music:  node test/fixtures/generate-sample.mjs
 */
import { zipSync } from 'fflate';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const DIVISION = 480;
const DURATIONS = {
  w: ['whole', 4], h: ['half', 2], q: ['quarter', 1], e: ['eighth', 0.5], s: ['16th', 0.25],
};
const LETTER_TPC = { C: 14, D: 16, E: 18, F: 13, G: 15, A: 17, B: 19 };
const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// ── The music ───────────────────────────────────────────────────────────────
// Sections are played in order; each has the same number of measures in both staves.
const SECTIONS = [
  {
    ts: [4, 4],
    treble: [
      // A: F | Bb | C | F — arpeggios
      'F4:e A4:e C5:e A4:e F4:e A4:e C5:q',
      'D5:e Bb4:e F4:e Bb4:e D5:e Bb4:e F4:q',
      'E4:e G4:e C5:e G4:e E4:e G4:e C5:q',
      'A4:q. G4:e F4:h',
      // B: Dm | Gm | C | F — dotted rhythms, rests, dyads
      'D5:q. C5:e A4:q F4:q',
      'Bb4:q G4:q D5:h',
      'E5+C5:q G4:q r:q E4:q',
      'F4+A4:h C5+F5:h',
      // C: F | Dm | Gm | chromatic run — sixteenths, then A#4 (= Bb4)
      'F4:s A4:s C5:s A4:s F4:s A4:s C5:s A4:s C5:q F5:q',
      'D5:e F5:e D5:e A4:e D5:h',
      'Bb4:e D5:e G5:e D5:e Bb4:q G4:q',
      'F4:e F#4:e G4:e G#4:e A4:e A#4:e B4:e C5:e',
      // D: recap
      'C5:q. A4:e F4:q A4:q',
      'D5:q. Bb4:e F4:h',
      'E5:e C5:e G4:e C5:e E5:h',
      'F4+A4+C5:w',
      // E: Gm | C | F | Bb — quarter-note melody over an eighth-note ostinato
      'Bb4:q D5:q G5:q D5:q',
      'C5:q E5:q G5:q E5:q',
      'A4:q C5:q F5:q C5:q',
      'Bb4:q D5:q F5:q D5:q',
      // F: Dm | Gm | C | F — off-beat entries
      'r:e D5:e F5:e D5:e A4:q F4:q',
      'r:e Bb4:e D5:e Bb4:e G4:q D4:q',
      'r:e C5:e E5:e C5:e G4:q E4:q',
      'F4:q A4:q C5:q F5:q',
    ],
    bass: [
      'F3:h C3:h',
      'Bb3:h F3:h',
      'C3:h G3:h',
      'F3:w',
      'D3:w',
      'G3:h D3:h',
      'C3:q r:q C3:h',
      'F3:w',
      'F3:q C3:q F3:q C3:q',
      'D3:h A3:h',
      'G3:h D3:h',
      'C3:q E3:q G3:q C4:q',
      'F3:q. C3:e F3:h',
      'Bb3:h F3:h',
      'C3:h G3:h',
      'F3:w',
      'G3:e D3:e G3:e D3:e G3:e D3:e G3:e D3:e',
      'C3:e G3:e C3:e G3:e C3:e G3:e C3:e G3:e',
      'F3:e C3:e F3:e C3:e F3:e C3:e F3:e C3:e',
      'Bb3:e F3:e Bb3:e F3:e Bb3:e F3:e Bb3:e F3:e',
      'D3:h A3:h',
      'G3:h D3:h',
      'C3:h G3:h',
      'F3:h C3:h',
    ],
  },
  {
    ts: [3, 4],
    treble: [
      // G: coda in 3/4
      'A4:q C5:q A4:q',
      'Bb4:q D5:q Bb4:q',
      'C5:q E5:q C5:q',
      'A4:q. F4:e A4:q',
      'A4:q D5:q A4:q',
      'Bb4:q D5:q G5:q',
      'G5:q E5:q C5:q',
      'F5+A4+F4:h.',
    ],
    bass: [
      'F3:q C3:h',
      'Bb3:q F3:h',
      'C3:q G3:h',
      'F3:q C3:q F3:q',
      'D3:q A3:q D3:q',
      'G3:q D3:q G3:q',
      'C3:q G3:q C3:q',
      'F3:h.',
    ],
  },
];

// ── Token parsing ───────────────────────────────────────────────────────────
function parsePitch(name) {
  const m = /^([A-G])([#b]*)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`Bad pitch: ${name}`);
  const [, letter, accs, oct] = m;
  const alter = [...accs].reduce((n, c) => n + (c === '#' ? 1 : -1), 0);
  return {
    name,
    midi: (parseInt(oct, 10) + 1) * 12 + LETTER_SEMITONE[letter] + alter,
    tpc: LETTER_TPC[letter] + 7 * alter,
  };
}

function parseToken(tok) {
  const [pitchPart, durPart] = tok.split(':');
  const dotted = durPart.endsWith('.');
  const [type, beats] = DURATIONS[durPart[0]];
  return {
    pitches: pitchPart === 'r' ? [] : pitchPart.split('+').map(parsePitch),
    type,
    dotted,
    beats: dotted ? beats * 1.5 : beats,
  };
}

// ── Oracle: the note events this score contains ─────────────────────────────
// Mirrors what a correct parser should return: onset/end in ticks, with
// enharmonic duplicates (same MIDI pitch, different spelling) merged to the
// spelling used most often.
function buildEvents() {
  const raw = [];
  for (const staff of ['treble', 'bass']) {
    let tick = 0;
    for (const sec of SECTIONS) {
      if (sec.treble.length !== sec.bass.length) throw new Error('Staves have different measure counts');
      const measureBeats = sec.ts[0] * 4 / sec.ts[1];
      for (const measure of sec[staff]) {
        const toks = measure.split(' ').map(parseToken);
        const total = toks.reduce((s, t) => s + t.beats, 0);
        if (total !== measureBeats) {
          throw new Error(`Measure "${measure}" is ${total} beats, expected ${measureBeats}`);
        }
        for (const t of toks) {
          const dur = t.beats * DIVISION;
          for (const p of t.pitches) raw.push({ name: p.name, onset: tick, end: tick + dur, midi: p.midi });
          tick += dur;
        }
      }
    }
  }
  const spellings = new Map();
  for (const e of raw) {
    const m = spellings.get(e.midi) ?? new Map();
    m.set(e.name, (m.get(e.name) ?? 0) + 1);
    spellings.set(e.midi, m);
  }
  const canonical = new Map(
    [...spellings].map(([midi, m]) => [midi, [...m].sort((a, b) => b[1] - a[1])[0][0]]),
  );
  return raw.map(e => ({ ...e, name: canonical.get(e.midi) }));
}

export const SAMPLE_EVENTS = buildEvents();

// ── MuseScore file ──────────────────────────────────────────────────────────
function measureXml(tokens, extras) {
  const body = tokens.map(t => {
    const dots = t.dotted ? '<dots>1</dots>' : '';
    if (!t.pitches.length) return `          <Rest>${dots}<durationType>${t.type}</durationType></Rest>`;
    const notes = t.pitches
      .map(p => `<Note><pitch>${p.midi}</pitch><tpc>${p.tpc}</tpc></Note>`)
      .join('');
    return `          <Chord>${dots}<durationType>${t.type}</durationType>${notes}</Chord>`;
  }).join('\n');
  return `      <Measure>\n        <voice>\n${extras}${body}\n        </voice>\n      </Measure>`;
}

function staffXml(id, staff) {
  const title = id === 1
    ? `      <VBox>
        <height>10</height>
        <boxAutoSize>0</boxAutoSize>
        <sizeIsSpatiumDependent>1</sizeIsSpatiumDependent>
        <Text><style>title</style><text>Sample Chimes</text></Text>
        <Text><style>composer</style><text>Handbell Manager test fixture</text></Text>
      </VBox>\n`
    : '';
  const measures = [];
  SECTIONS.forEach((sec, si) => {
    sec[staff].forEach((m, mi) => {
      let extras = '';
      if (si === 0 && mi === 0) extras += '          <KeySig><concertKey>-1</concertKey></KeySig>\n';
      if (mi === 0) {
        extras += `          <TimeSig><sigN>${sec.ts[0]}</sigN><sigD>${sec.ts[1]}</sigD></TimeSig>\n`;
      }
      measures.push(measureXml(m.split(' ').map(parseToken), extras));
    });
  });
  return `    <Staff id="${id}">\n${title}${measures.join('\n')}\n    </Staff>`;
}

export function buildSampleMscz() {
  const mscx = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.70">
  <Score>
    <Division>${DIVISION}</Division>
    <metaTag name="composer">Handbell Manager test fixture</metaTag>
    <metaTag name="workTitle">Sample Chimes</metaTag>
    <Part id="1">
      <Staff>
        <StaffType group="pitched"></StaffType>
        <bracket type="1" span="2" col="0" visible="1"/>
        <barLineSpan>1</barLineSpan>
      </Staff>
      <Staff>
        <StaffType group="pitched"></StaffType>
        <defaultClef>F</defaultClef>
      </Staff>
      <trackName>Piano</trackName>
      <Instrument id="piano">
        <instrumentId>keyboard.piano</instrumentId>
        <Channel><program value="0"/></Channel>
      </Instrument>
    </Part>
${staffXml(1, 'treble')}
${staffXml(2, 'bass')}
  </Score>
</museScore>
`;
  const enc = new TextEncoder();
  // Fixed mtime keeps regenerated files byte-identical when the music is unchanged.
  return zipSync({
    'META-INF/container.xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<container><rootfiles><rootfile full-path="Sample.mscx"/></rootfiles></container>\n`,
    ),
    'Sample.mscx': enc.encode(mscx),
  }, { level: 6, mtime: new Date(2026, 0, 1) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'Sample.mscz');
  writeFileSync(out, buildSampleMscz());
  console.log(`Wrote ${out} (${SAMPLE_EVENTS.length} notes, ${new Set(SAMPLE_EVENTS.map(e => e.name)).size} distinct bells)`);
}

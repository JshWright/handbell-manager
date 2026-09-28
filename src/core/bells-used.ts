/**
 * Build a tiny standalone "bells used" score: a single treble staff holding one
 * stemless notehead per bell, low→high, each tinted with the same color the
 * player's full score uses. Rendered to a trimmed image and stamped onto the
 * top of the player's PDF (see src/main/pdf-compose.ts) — a color key that
 * shows, at a glance, exactly which bells that player rings.
 */
import { zipSync } from 'fflate';
import { Rgb } from './pdf-color';

// Natural-note tonal pitch class (the value MuseScore stores in <tpc>) and
// chromatic semitone offset within an octave, keyed by letter name.
const LETTER_TPC: Record<string, number> = { C: 14, D: 16, E: 18, F: 13, G: 15, A: 17, B: 19 };
const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Convert a bell name like "C4", "F#5", or "Bb3" into MuseScore pitch + tpc. */
export function nameToPitchTpc(name: string): { midi: number; tpc: number } {
  const m = /^([A-G])([#b]*)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`Unparseable bell name: ${name}`);
  const [, letter, accs, octStr] = m;
  let alter = 0;
  for (const c of accs) alter += c === '#' ? 1 : -1;
  const octave = parseInt(octStr, 10);
  const midi = (octave + 1) * 12 + LETTER_SEMITONE[letter] + alter;
  const tpc = LETTER_TPC[letter] + 7 * alter;
  return { midi, tpc };
}

/**
 * Build the "bells used" .mscz for one player. `orderedNames` must be sorted
 * low→high; `colorByName` supplies each bell's RGB (from resolveBellColors, so
 * it matches the colored score exactly).
 */
export function buildBellsUsedScore(
  orderedNames: string[],
  colorByName: Map<string, Rgb>,
): Uint8Array {
  const n = orderedNames.length;
  const chords = orderedNames.map((name) => {
    const { midi, tpc } = nameToPitchTpc(name);
    const [r, g, b] = colorByName.get(name) ?? [0, 0, 0];
    return (
      `          <Chord><durationType>quarter</durationType><noStem>1</noStem>\n` +
      `            <Note><pitch>${midi}</pitch><tpc>${tpc}</tpc>` +
      `<color r="${r}" g="${g}" b="${b}" a="255"/></Note></Chord>`
    );
  }).join('\n');

  // A single measure whose length equals the note count keeps every bell on one
  // line with no trailing rests; a generously wide page prevents system wrap
  // (the image is trimmed to content afterward, so the extra width is free).
  const pageWidth = Math.max(10, n * 2.2);
  const mscx = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.70">
  <Score>
    <Division>480</Division>
    <Style>
      <pageWidth>${pageWidth.toFixed(1)}</pageWidth>
      <pageHeight>8</pageHeight>
      <pagePrintableWidth>${(pageWidth - 0.5).toFixed(1)}</pagePrintableWidth>
      <spatium>1.6</spatium>
    </Style>
    <Part id="1">
      <Staff><StaffType group="pitched"></StaffType></Staff>
      <trackName>Bells</trackName>
      <Instrument id="piano"><instrumentId>keyboard.piano</instrumentId><Channel><program value="0"/></Channel></Instrument>
    </Part>
    <Staff id="1">
      <Measure len="${n}/4">
        <voice>
${chords}
        </voice>
      </Measure>
    </Staff>
  </Score>
</museScore>`;

  const enc = new TextEncoder();
  return zipSync({
    'META-INF/container.xml': enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<container><rootfiles><rootfile full-path="score.mscx"/></rootfiles></container>\n`,
    ),
    'score.mscx': enc.encode(mscx),
  }, { level: 6 });
}

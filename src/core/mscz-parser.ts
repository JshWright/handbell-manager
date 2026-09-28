/**
 * Parse a MuseScore (.mscz) file into timed note events.
 *
 * Known limitations: repeats/D.S./codas not expanded, tuplets not handled,
 * single-instrument.
 */
import { unzipSync } from 'fflate';
import { DOMParser, XMLSerializer, Element as XmlElement, Document as XmlDocument } from '@xmldom/xmldom';

export interface NoteEvent {
  name: string;   // e.g. "C4"
  onset: number;  // ticks from start
  end: number;    // onset + duration in ticks
  midi: number;
}

const DURATION_TICKS: Record<string, number> = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5,
  '16th': 0.25, '32nd': 0.125, '64th': 0.0625,
};

const LETTERS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'];
const SEMITONES = [0, 7, 2, 9, 4, 11, 5]; // pitch class for C G D A E B F

export function tpcToName(tpc: number): string {
  tpc = Math.trunc(tpc);
  const idx = ((tpc - 14) % 7 + 7) % 7;
  const alter = Math.floor((tpc + 1) / 7) - 2;
  let base = LETTERS[idx];
  if (alter > 0) base += '#'.repeat(alter);
  else if (alter < 0) base += 'b'.repeat(-alter);
  return base;
}

// Returns the chromatic pitch class (0–11) implied by a TPC value.
function pitchClassFromTpc(tpc: number): number {
  tpc = Math.trunc(tpc);
  const idx = ((tpc - 14) % 7 + 7) % 7;
  const alter = Math.floor((tpc + 1) / 7) - 2;
  return (SEMITONES[idx] + alter + 120) % 12;
}

function getMscxEntry(bytes: Uint8Array): { name: string; data: Uint8Array } {
  const files = unzipSync(bytes);
  const name = Object.keys(files).find(k => k.toLowerCase().endsWith('.mscx'));
  if (!name) throw new Error('No .mscx found in this .mscz file.');
  return { name, data: files[name] };
}

function findMscxRoot(bytes: Uint8Array): XmlDocument {
  const { data } = getMscxEntry(bytes);
  const xml = new TextDecoder().decode(data);
  return new DOMParser().parseFromString(xml, 'text/xml');
}

function findFirst(node: XmlDocument | XmlElement, tagPath: string): XmlElement | null {
  const tags = tagPath.split('/');
  let current: XmlDocument | XmlElement = node;
  for (const tag of tags) {
    const found = getElementsByTagName(current, tag)[0];
    if (!found) return null;
    current = found;
  }
  return current as XmlElement;
}

function getElementsByTagName(node: XmlDocument | XmlElement, tag: string): XmlElement[] {
  const results: XmlElement[] = [];
  const nl = (node as XmlDocument).getElementsByTagName
    ? (node as XmlDocument).getElementsByTagName(tag)
    : (node as XmlElement).getElementsByTagName(tag);
  for (let i = 0; i < nl.length; i++) results.push(nl[i] as XmlElement);
  return results;
}

function textContent(node: XmlDocument | XmlElement, tag: string, fallback = ''): string {
  const el = getElementsByTagName(node, tag)[0];
  return el ? (el.textContent ?? fallback) : fallback;
}

export function getDivision(msczBytes: Uint8Array): number {
  const doc = findMscxRoot(msczBytes);
  const divEl = getElementsByTagName(doc, 'Division')[0];
  if (!divEl) throw new Error('No Division element found in score.');
  return parseInt(divEl.textContent!, 10);
}

export interface NoteWithElement {
  event: NoteEvent;
  element: XmlElement;
}

function walkNotes(doc: XmlDocument): NoteWithElement[] {
  const divEl = getElementsByTagName(doc, 'Division')[0];
  if (!divEl) throw new Error('No Division found.');
  const division = parseInt(divEl.textContent!, 10);

  const durTicks: Record<string, number> = {};
  for (const [k, v] of Object.entries(DURATION_TICKS)) {
    durTicks[k] = Math.round(v * division);
  }

  const pairs: NoteWithElement[] = [];
  const allStaves = getElementsByTagName(doc, 'Staff');

  for (const staff of allStaves) {
    // Only process top-level score staves (those with an 'id' attribute)
    if (!staff.getAttribute('id')) continue;

    let sigN = 4, sigD = 4;
    let measureTick = 0;

    const measures = getElementsByTagName(staff, 'Measure');
    for (const measure of measures) {
      const voices = getElementsByTagName(measure, 'voice');
      for (const voice of voices) {
        let tick = measureTick;
        const children = voice.childNodes;
        for (let ci = 0; ci < children.length; ci++) {
          const el = children[ci] as XmlElement;
          if (!el.tagName) continue;

          if (el.tagName === 'TimeSig') {
            const n = textContent(el, 'sigN', '4');
            const d = textContent(el, 'sigD', '4');
            sigN = parseInt(n, 10);
            sigD = parseInt(d, 10);
          } else if (el.tagName === 'Chord' || el.tagName === 'Rest') {
            const dtype = textContent(el, 'durationType', '');
            const base = durTicks[dtype] ?? 0;
            const dotsStr = textContent(el, 'dots', '');
            let dur = base;
            if (dotsStr) {
              const d = parseInt(dotsStr, 10);
              dur = Math.round(base * (2 - Math.pow(0.5, d)));
            }
            if (el.tagName === 'Chord') {
              const notes = getElementsByTagName(el, 'Note');
              for (const note of notes) {
                const tpcStr = textContent(note, 'tpc', '');
                const pitchStr = textContent(note, 'pitch', '');
                if (!tpcStr || !pitchStr) continue;
                let tpc = parseInt(tpcStr, 10);
                const pitch = parseInt(pitchStr, 10);
                // If the TPC-derived pitch class doesn't match the MIDI pitch
                // (e.g. a transposing-instrument score where <tpc> holds the
                // written pitch and <tpc2> holds the concert pitch), prefer
                // whichever TPC is consistent with the MIDI pitch.
                if (pitchClassFromTpc(tpc) !== pitch % 12) {
                  const tpc2Str = textContent(note, 'tpc2', '');
                  if (tpc2Str) {
                    const tpc2 = parseInt(tpc2Str, 10);
                    if (pitchClassFromTpc(tpc2) === pitch % 12) tpc = tpc2;
                  }
                }
                const name = tpcToName(tpc);
                const octave = Math.floor(pitch / 12) - 1;
                pairs.push({
                  event: {
                    name: `${name}${octave}`,
                    onset: tick,
                    end: tick + dur,
                    midi: pitch,
                  },
                  element: note,
                });
              }
            }
            tick += dur;
          }
        }
      }

      const ticksPerMeasure = Math.round(sigN * (4 * division / sigD));
      measureTick += ticksPerMeasure;
    }
  }

  return pairs;
}

// Resolve enharmonic duplicates: notes at the same MIDI pitch that carry
// different TPC-derived names (e.g. A#4 vs Bb4) are unified to whichever
// spelling appears most often in the score. This prevents the assigner from
// treating them as separate bells and the PDF highlighter from missing notes.
function normalizeEnharmonics(pairs: NoteWithElement[]): NoteWithElement[] {
  const counts = new Map<number, Map<string, number>>();
  for (const { event } of pairs) {
    let m = counts.get(event.midi);
    if (!m) counts.set(event.midi, m = new Map());
    m.set(event.name, (m.get(event.name) ?? 0) + 1);
  }
  const canonical = new Map<number, string>();
  for (const [midi, m] of counts) {
    let best = '', bestN = 0;
    for (const [name, count] of m) if (count > bestN) { bestN = count; best = name; }
    canonical.set(midi, best);
  }
  return pairs.map(p => ({
    element: p.element,
    event: { ...p.event, name: canonical.get(p.event.midi) ?? p.event.name },
  }));
}

export function parseNotes(msczBytes: Uint8Array): NoteEvent[] {
  const doc = findMscxRoot(msczBytes);
  return normalizeEnharmonics(walkNotes(doc)).map(p => p.event);
}

export function parseNotesWithElements(msczBytes: Uint8Array): {
  doc: XmlDocument;
  allFiles: Record<string, Uint8Array>;
  mscxName: string;
  pairs: NoteWithElement[];
} {
  const files = unzipSync(msczBytes);
  const mscxName = Object.keys(files).find(k => k.toLowerCase().endsWith('.mscx'));
  if (!mscxName) throw new Error('No .mscx found in this .mscz file.');
  const xml = new TextDecoder().decode(files[mscxName]);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const pairs = normalizeEnharmonics(walkNotes(doc));
  return { doc, allFiles: files, mscxName, pairs };
}

export function debugParse(msczBytes: Uint8Array): string {
  try {
    const files = unzipSync(msczBytes);
    const fileList = Object.keys(files).join(', ');
    const mscxName = Object.keys(files).find(k => k.toLowerCase().endsWith('.mscx'));
    if (!mscxName) return `ZIP entries: [${fileList}] — no .mscx found`;

    const xml = new TextDecoder().decode(files[mscxName]);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');

    const allStaves = getElementsByTagName(doc, 'Staff');
    const stavesWithId = allStaves.filter(s => !!s.getAttribute('id'));
    const measures = stavesWithId.flatMap(s => getElementsByTagName(s, 'Measure'));
    const voices = measures.flatMap(m => getElementsByTagName(m, 'voice'));
    const chords = voices.flatMap(v => getElementsByTagName(v, 'Chord'));
    const notes = chords.flatMap(c => getElementsByTagName(c, 'Note'));

    return [
      `ZIP entries: [${fileList}]`,
      `All <Staff> elements: ${allStaves.length}`,
      `<Staff> with id attr: ${stavesWithId.length}`,
      `<Measure> elements: ${measures.length}`,
      `<voice> elements: ${voices.length}`,
      `<Chord> elements: ${chords.length}`,
      `<Note> elements: ${notes.length}`,
    ].join('\n');
  } catch (e: unknown) {
    return `Debug error: ${(e as Error).message}`;
  }
}

export function noteCounts(events: NoteEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.name, (m.get(e.name) ?? 0) + 1);
  return m;
}

export function notesByPitch(events: NoteEvent[]): Array<{ name: string; count: number }> {
  const counts = noteCounts(events);
  const midi = new Map<string, number>();
  for (const e of events) midi.set(e.name, e.midi);
  return [...counts.entries()]
    .sort((a, b) => (midi.get(a[0]) ?? 0) - (midi.get(b[0]) ?? 0))
    .map(([name, count]) => ({ name, count }));
}

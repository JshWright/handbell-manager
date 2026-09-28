/**
 * Color specific bells in a score and repackage as a .mscz byte array.
 *
 * The mscore CLI invocation lives in src/main/mscore.ts (it needs the
 * filesystem and child_process, which aren't available in the pure core).
 */
import { zipSync } from 'fflate';
import { XMLSerializer, Document as XmlDocument, Element as XmlElement } from '@xmldom/xmldom';
import { parseNotesWithElements } from './mscz-parser';

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q];
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export type Rgb = [number, number, number];

export function distinctColors(n: number): Array<Rgb> {
  return Array.from({ length: n }, (_, i) => hsvToRgb(i / n, 0.75, 0.85));
}

/**
 * Resolve the RGB color for each bell: an explicit hex override when supplied,
 * otherwise an auto HSV color keyed to the bell's position in pitch order.
 * `orderedNames` must already be sorted low→high so the auto palette is stable.
 */
export function resolveBellColors(
  orderedNames: string[],
  bellColors?: Record<string, string>,
): Map<string, Rgb> {
  const autoColors = distinctColors(orderedNames.length);
  return new Map(orderedNames.map((n, i) => [
    n,
    bellColors?.[n] ? hexToRgb(bellColors[n]) : autoColors[i],
  ]));
}

function injectPlayerName(doc: XmlDocument, playerName: string): void {
  const vboxList = doc.getElementsByTagName('VBox');
  let vbox: XmlElement | null = vboxList.length > 0 ? (vboxList[0] as XmlElement) : null;

  if (!vbox) {
    // No title frame — insert one before the first Measure in Staff id="1"
    const staves = doc.getElementsByTagName('Staff');
    let firstStaff: XmlElement | null = null;
    for (let i = 0; i < staves.length; i++) {
      const s = staves[i] as XmlElement;
      if (s.getAttribute('id') === '1') { firstStaff = s; break; }
    }
    if (!firstStaff && staves.length > 0) firstStaff = staves[0] as XmlElement;
    if (!firstStaff) return;

    const measures = firstStaff.getElementsByTagName('Measure');
    const firstMeasure = measures.length > 0 ? (measures[0] as XmlElement) : null;

    const newMeasure = doc.createElement('Measure');
    newMeasure.setAttribute('number', '0');
    vbox = doc.createElement('VBox');
    const heightEl = doc.createElement('height');
    heightEl.textContent = '10';
    vbox.appendChild(heightEl);
    newMeasure.appendChild(vbox);

    if (firstMeasure) {
      firstStaff.insertBefore(newMeasure, firstMeasure);
    } else {
      firstStaff.appendChild(newMeasure);
    }
  }

  // Find existing subtitle Text element within the VBox
  const texts = vbox.getElementsByTagName('Text');
  let subtitleText: XmlElement | null = null;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] as XmlElement;
    // Only look at direct-child Text elements (not nested ones)
    if (t.parentNode !== vbox) continue;
    const styleEls = t.getElementsByTagName('style');
    if (styleEls.length > 0 && (styleEls[0] as XmlElement).textContent === 'Subtitle') {
      subtitleText = t;
      break;
    }
  }

  if (subtitleText) {
    const textEls = subtitleText.getElementsByTagName('text');
    if (textEls.length > 0) {
      (textEls[0] as XmlElement).textContent = playerName;
    }
  } else {
    const textFrame = doc.createElement('Text');
    const styleEl = doc.createElement('style');
    styleEl.textContent = 'Subtitle';
    const textEl = doc.createElement('text');
    textEl.textContent = playerName;
    textFrame.appendChild(styleEl);
    textFrame.appendChild(textEl);
    vbox.appendChild(textFrame);
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export interface ColorOptions {
  playerName?: string;
  bellColors?: Record<string, string>;
  colorNotes?: boolean;   // default true
  showArrows?: boolean;   // default true
}

export interface ColoredScore {
  mscz: Uint8Array;               // the recolored .mscz bytes
  orderedNames: string[];         // the player's bells, low→high
  colorByName: Map<string, Rgb>;  // resolved color per bell (matches the score)
}

export function colorPlayerScore(
  msczBytes: Uint8Array,
  noteNames: Set<string>,
  options?: ColorOptions,
): ColoredScore {
  const { playerName, bellColors, colorNotes = true, showArrows = true } = options ?? {};
  const { doc, allFiles, mscxName, pairs } = parseNotesWithElements(msczBytes);

  // Sort by midi so colors are consistent (lowest bell = first color)
  const midiByName = new Map<string, number>();
  for (const { event } of pairs) {
    if (noteNames.has(event.name)) midiByName.set(event.name, event.midi);
  }
  const orderedNames = [...noteNames].sort(
    (a, b) => (midiByName.get(a) ?? 0) - (midiByName.get(b) ?? 0),
  );
  const colorByName = resolveBellColors(orderedNames, bellColors);

  for (const { event, element } of pairs) {
    const color = colorByName.get(event.name);
    if (!color) continue;
    const [r, g, b] = color;
    const noteDoc = element.ownerDocument!;

    if (colorNotes) {
      const colorEl = noteDoc.createElement('color');
      colorEl.setAttribute('r', String(r));
      colorEl.setAttribute('g', String(g));
      colorEl.setAttribute('b', String(b));
      colorEl.setAttribute('a', '255');
      element.appendChild(colorEl);
    }

    if (showArrows) {
      const fingerEl = noteDoc.createElement('Fingering');
      const fingerColorEl = noteDoc.createElement('color');
      fingerColorEl.setAttribute('r', String(r));
      fingerColorEl.setAttribute('g', String(g));
      fingerColorEl.setAttribute('b', String(b));
      fingerColorEl.setAttribute('a', '255');
      const textEl = noteDoc.createElement('text');
      textEl.textContent = '▲';
      fingerEl.appendChild(fingerColorEl);
      fingerEl.appendChild(textEl);
      element.appendChild(fingerEl);
    }
  }

  if (playerName) injectPlayerName(doc, playerName);

  const serializer = new XMLSerializer();
  const newMscx = serializer.serializeToString(doc);
  const newMscxBytes = new TextEncoder().encode(newMscx);

  const outFiles: Record<string, Uint8Array> = { ...allFiles, [mscxName]: newMscxBytes };
  return { mscz: zipSync(outFiles, { level: 6 }), orderedNames, colorByName };
}

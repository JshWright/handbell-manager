/**
 * Renderer — a single live workspace.
 *
 * Load a file once, then every control (ringer count, minimums, pins) drives a
 * debounced recompute. Player names are edited inline on each card and do NOT
 * trigger a recompute — they don't affect the assignment math, only its labels.
 * All filesystem/IPC work goes through window.bell (see preload.ts).
 */

interface NoteInfo { name: string; count: number }
interface ParseResult { division: number; notes: NoteInfo[]; distinctCount: number; filename: string }
interface Assignment {
  players: string[][];
  playerSums: number[];
  spread: number;
  counts: Record<string, number>;
  pitchCost: number;
  conflicts: Record<string, string[]>;
  playerNames: string[] | null;
  pinned: Record<string, number>;
  minCount: number | null;
  minGapBeats: number | null;
  handsPerPlayer: number;
  hands: Record<string, number>;
  hasConflicts: boolean;
}

const bell = (window as unknown as { bell: {
  openFile(): Promise<string | null>;
  pathForFile(file: File): string;
  parse(filePath: string): Promise<ParseResult | { error: string }>;
  assign(args: {
    filePath: string; nPlayers: number; pins: Record<string, number>;
    playerNames: string[]; minCount: number | null; minGapBeats: number | null; division: number;
    handsPerPlayer: number;
  }): Promise<{ assignment: Assignment } | { error: string }>;
  exportPdf(args: { filePath: string; playerIdx: number; noteNames: string[]; suggestedName: string; playerName?: string; bellColors?: Record<string, string>; colorNotes?: boolean; showArrows?: boolean; bellsUsedHeader?: boolean }): Promise<{ savedTo?: string; canceled?: boolean; error?: string; needMuseScore?: boolean }>;
  exportAllPdf(args: { players: { filePath: string; playerIdx: number; noteNames: string[]; playerName?: string; bellColors?: Record<string, string>; colorNotes?: boolean; showArrows?: boolean; bellsUsedHeader?: boolean }[]; suggestedName: string }): Promise<{ savedTo?: string; count?: number; canceled?: boolean; error?: string; needMuseScore?: boolean }>;
  exportCsv(args: { assignment: Assignment; suggestedName: string }): Promise<{ savedTo?: string; canceled?: boolean; error?: string }>;
} }).bell;

// ── State ────────────────────────────────────────────────────────────────────
let filePath: string | null = null;
let filename = '';
let parse: ParseResult | null = null;
let assignment: Assignment | null = null;

let nPlayers = 10;
let minCount: number | null = null;
let minGapBeats: number | null = null;
let twoHand = true;
const pins: Record<string, number> = {};         // bell name -> 0-based player index
let names: string[] = [];                         // '' means use default "Player N"
const bellColors: Record<string, string> = {};    // bell name -> hex color
let pdfColorNotes = true;
let pdfShowArrows = true;
let pdfBellsUsedHeader = true;

// Standard handbell tag colors, keyed by note class (same color in every octave)
const HANDBELL_COLORS: Record<string, string> = {
  'C':  '#FF0000',
  'C#': '#FF5100', 'Db': '#FF5100',
  'D':  '#FF8000',
  'D#': '#FFD000', 'Eb': '#FFD000',
  'E':  '#D9CD25',
  'F':  '#008000',
  'F#': '#00CCA8', 'Gb': '#00CCA8',
  'G':  '#0000FF',
  'G#': '#6400E8', 'Ab': '#6400E8',
  'A':  '#600080',
  'A#': '#D000FF', 'Bb': '#D000FF',
  'B':  '#FF00FF',
};

let recomputeSeq = 0;
let recomputeTimer: number | undefined;

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const stem = () => filename.replace(/\.mscz$/i, '');
const safeName = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const displayName = (i: number) => (names[i]?.trim() || `Player ${i + 1}`);

function setStatus(msg: string, kind: '' | 'good' | 'bad' = '') {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

// ── File loading ─────────────────────────────────────────────────────────────
async function loadFile(path: string) {
  const result = await bell.parse(path);
  if ('error' in result) { showEmptyError(result.error); return; }

  filePath = path;
  parse = result;
  filename = result.filename;

  // Sensible defaults / clamp against the score.
  nPlayers = Math.min(nPlayers || 10, result.distinctCount);
  minCount = null;
  minGapBeats = null;
  for (const k of Object.keys(pins)) delete pins[k];
  names = Array.from({ length: nPlayers }, () => '');

  // Assign default colors by note class (same color in every octave, matching physical handbell tags)
  for (const k of Object.keys(bellColors)) delete bellColors[k];
  for (const { name } of result.notes) {
    const noteClass = name.match(/^([A-G][#b]*)/)?.[1] ?? '';
    bellColors[name] = HANDBELL_COLORS[noteClass] ?? '#888888';
  }

  ($('n-players') as HTMLInputElement).value = String(nPlayers);
  ($('min-count') as HTMLInputElement).value = '';
  ($('min-gap') as HTMLInputElement).value = '';

  $('empty').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('file-name').textContent = filename;
  $('file-sub').textContent = `${result.distinctCount} bells · ${result.notes.reduce((s, n) => s + n.count, 0)} notes`;
  $('toolbar-name').textContent = filename;
  $('players-hint').textContent = `1–${result.distinctCount} (distinct bells in score)`;

  buildToolbarActions();
  buildBellList();
  recompute(true);
}

function showEmptyError(msg: string) {
  const e = $('empty-error');
  e.textContent = msg;
  e.classList.remove('hidden');
}

// ── Sidebar: bell / pin list ─────────────────────────────────────────────────
function buildBellList() {
  const list = $('bell-list');
  list.innerHTML = '';
  for (const { name, count } of parse!.notes) {
    const row = el('div', 'bell-row');
    row.dataset.bell = name;

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'color-swatch';
    swatch.value = bellColors[name] ?? '#888888';
    swatch.title = `Color for ${name}`;
    swatch.addEventListener('input', () => {
      bellColors[name] = swatch.value;
    });

    const id = el('div', 'bell-id');
    id.append(el('span', 'bell-name', name), el('span', 'bell-ct', String(count)));

    const sel = el('select', 'pin-select') as HTMLSelectElement;
    sel.append(new Option('Auto', 'auto'));
    for (let i = 1; i <= nPlayers; i++) sel.append(new Option(displayName(i - 1), String(i)));
    sel.value = pins[name] != null ? String(pins[name] + 1) : 'auto';
    sel.addEventListener('change', () => {
      if (sel.value === 'auto') delete pins[name];
      else pins[name] = parseInt(sel.value, 10) - 1;
      reflectPinState();
      recompute();
    });

    row.append(swatch, id, sel);
    list.append(row);
  }
  reflectPinState();
}

/** Refresh pin-select options when the ringer count changes (add/remove Pn). */
function refreshPinOptions() {
  for (const row of Array.from($('bell-list').querySelectorAll<HTMLElement>('.bell-row'))) {
    const name = row.dataset.bell!;
    const sel = row.querySelector('select')!;
    const current = pins[name] != null ? String(pins[name] + 1) : 'auto';
    sel.innerHTML = '';
    sel.append(new Option('Auto', 'auto'));
    for (let i = 1; i <= nPlayers; i++) sel.append(new Option(displayName(i - 1), String(i)));
    sel.value = current;
  }
  reflectPinState();
}

/** Re-label pin options in place when a player is renamed (values unchanged). */
function refreshPinLabels() {
  for (const sel of Array.from($('bell-list').querySelectorAll<HTMLSelectElement>('.pin-select'))) {
    for (const opt of Array.from(sel.options)) {
      if (opt.value !== 'auto') opt.textContent = displayName(parseInt(opt.value, 10) - 1);
    }
  }
}

function reflectPinState() {
  for (const row of Array.from($('bell-list').querySelectorAll<HTMLElement>('.bell-row'))) {
    const name = row.dataset.bell!;
    const pinned = pins[name] != null;
    row.classList.toggle('pinned', pinned);
    row.querySelector('select')!.classList.toggle('active', pinned);
  }
  const n = Object.keys(pins).length;
  $('pin-count').textContent = n ? `${n} pinned` : '';
}

// ── Ringer count ─────────────────────────────────────────────────────────────
function setPlayers(n: number) {
  const max = parse!.distinctCount;
  n = Math.max(1, Math.min(max, Math.floor(n) || 1));
  if (n === nPlayers) return;
  nPlayers = n;
  ($('n-players') as HTMLInputElement).value = String(n);

  // Drop pins pointing at players that no longer exist; resize names.
  for (const k of Object.keys(pins)) if (pins[k] >= n) delete pins[k];
  names = Array.from({ length: n }, (_, i) => names[i] ?? '');

  refreshPinOptions();
  recompute();
}

// ── Recompute (debounced, race-safe) ─────────────────────────────────────────
function recompute(immediate = false) {
  window.clearTimeout(recomputeTimer);
  const run = async () => {
    const seq = ++recomputeSeq;
    $('player-grid').classList.add('busy');
    const res = await bell.assign({
      filePath: filePath!, nPlayers, pins, playerNames: names.map((_, i) => displayName(i)),
      minCount, minGapBeats, division: parse!.division,
      handsPerPlayer: twoHand ? 2 : 1,
    });
    if (seq !== recomputeSeq) return;            // a newer edit superseded this one
    $('player-grid').classList.remove('busy');

    if ('error' in res) {
      const w = $('results-error');
      w.textContent = res.error;
      w.classList.remove('hidden');
      return;
    }
    const w = $('results-error');
    if (res.assignment.hasConflicts) {
      w.textContent = 'No conflict-free arrangement found — showing best effort. Bells marked with a warning share playing time with another bell assigned to the same player.';
      w.classList.remove('hidden');
    } else {
      w.classList.add('hidden');
    }
    assignment = res.assignment;
    renderStats();
    renderPlayers();
  };
  if (immediate) run();
  else recomputeTimer = window.setTimeout(run, 120);
}

// ── Results: stat strip ──────────────────────────────────────────────────────
function renderStats() {
  const a = assignment!;
  const total = Object.values(a.counts).reduce((s, c) => s + c, 0);
  const min = Math.min(...a.playerSums), max = Math.max(...a.playerSums);
  const strip = $('stat-strip');
  strip.innerHTML = '';

  const stat = (val: string, key: string) => {
    const s = el('div', 'stat');
    s.append(el('span', 'val', val), el('span', 'key', key));
    return s;
  };
  strip.append(
    stat(String(nPlayers), 'Ringers'),
    stat(String(total), 'Total strikes'),
    stat(`${min}–${max}`, 'Per player'),
    stat(String(a.spread), 'Spread'),
    stat(String(a.pitchCost), 'Pitch cost'),
  );
  strip.append(el('div', 'stat-spacer'));
  strip.append(el('span', a.hasConflicts ? 'stat-badge conflict' : 'stat-badge',
    a.hasConflicts ? 'Has conflicts' : 'Conflict-free'));
}

// ── Results: player cards ────────────────────────────────────────────────────
function renderPlayers() {
  const a = assignment!;
  const maxSum = Math.max(1, ...a.playerSums);
  const grid = $('player-grid');
  grid.innerHTML = '';

  for (let idx = 0; idx < a.players.length; idx++) {
    const card = el('article', 'player-card');

    // Head: editable name + strike badge
    const head = el('div', 'card-head');
    const name = el('input', 'name-input') as HTMLInputElement;
    name.value = displayName(idx);
    name.spellcheck = false;
    name.addEventListener('focus', () => name.select());
    name.addEventListener('input', () => {
      names[idx] = name.value;
      if (assignment?.playerNames) assignment.playerNames[idx] = displayName(idx);
      refreshPinLabels();
    });
    head.append(name, el('span', 'strike-badge', String(a.playerSums[idx])));

    // Bells
    const playerBells = a.players[idx];
    const makeTag = (b: string) => {
      const intraConflict = playerBells.some(other =>
        other !== b && a.conflicts[b]?.includes(other) && a.hands[b] === a.hands[other]);
      let cls = 'bell-tag';
      if (a.pinned[b] === idx) cls += ' pinned';
      if (intraConflict) cls += ' conflict';
      const tag = el('span', cls);
      tag.append(document.createTextNode(b + ' '), el('span', 'tag-ct', `(${a.counts[b]})`));
      return tag;
    };

    const usesTwoHands = twoHand && playerBells.some(b => a.hands[b] === 1);
    let bells: HTMLElement;
    if (usesTwoHands) {
      bells = el('div', 'card-bells card-bells-hands');
      for (const handIdx of [0, 1] as const) {
        const handBells = playerBells.filter(b => (a.hands[b] ?? 0) === handIdx);
        if (!handBells.length) continue;
        const row = el('div', 'hand-row');
        row.append(el('span', 'hand-label', handIdx === 0 ? 'L' : 'R'));
        const tags = el('div', 'hand-tags');
        for (const b of handBells) tags.append(makeTag(b));
        row.append(tags);
        bells.append(row);
      }
    } else {
      bells = el('div', 'card-bells');
      for (const b of playerBells) bells.append(makeTag(b));
    }

    // Balance bar
    const bal = el('div', 'balance');
    const fill = el('div', 'balance-fill');
    fill.style.width = `${(a.playerSums[idx] / maxSum) * 100}%`;
    bal.append(fill);

    // Foot: PDF
    const foot = el('div', 'card-foot');
    const pdf = el('button', 'pdf-btn', 'Download PDF') as HTMLButtonElement;
    const note = el('span', 'card-note');
    pdf.addEventListener('click', () => exportPdf(idx, a.players[idx], pdf, note));
    foot.append(pdf, note);

    card.append(head, bells, bal, foot);
    grid.append(card);
  }
}

async function exportPdf(idx: number, noteNames: string[], btn: HTMLButtonElement, note: HTMLElement) {
  const label = displayName(idx);
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Generating…';
  note.textContent = '';
  const res = await bell.exportPdf({
    ...playerPdfSpec(idx, noteNames),
    suggestedName: `${stem()}_${safeName(label)}.pdf`,
  });
  btn.disabled = false;
  btn.textContent = prev;
  if (res.canceled) return;
  if (res.error) {
    setStatus(res.needMuseScore
      ? 'PDF export needs MuseScore 4 — install it from musescore.org, then try again.'
      : `PDF error: ${res.error}`, 'bad');
  } else {
    note.textContent = 'Saved ✓';
    setStatus(`Saved ${res.savedTo}`, 'good');
  }
}

// ── Toolbar actions ──────────────────────────────────────────────────────────
function buildToolbarActions() {
  const box = $('toolbar-actions');
  box.innerHTML = '';

  const allPdf = el('button', 'pill-btn', 'Export all PDFs') as HTMLButtonElement;
  allPdf.addEventListener('click', () => exportAllPdfs(allPdf));
  box.append(allPdf);

  const csv = el('button', 'pill-btn', 'Export CSV');
  csv.addEventListener('click', async () => {
    if (!assignment) return;
    assignment.playerNames = names.map((_, i) => displayName(i));
    const res = await bell.exportCsv({ assignment, suggestedName: `${stem()}_assignments.csv` });
    if (res.error) setStatus(`CSV error: ${res.error}`, 'bad');
    else if (!res.canceled) setStatus(`Saved ${res.savedTo}`, 'good');
  });
  box.append(csv);
}

/** Build the export spec for one player's colored PDF. */
function playerPdfSpec(idx: number, noteNames: string[]) {
  const playerBellColors = Object.fromEntries(
    noteNames.map(n => [n, bellColors[n]]).filter(([, v]) => v),
  );
  return {
    filePath: filePath!, playerIdx: idx, noteNames,
    playerName: displayName(idx),
    bellColors: playerBellColors,
    colorNotes: pdfColorNotes,
    showArrows: pdfShowArrows,
    bellsUsedHeader: pdfBellsUsedHeader,
  };
}

async function exportAllPdfs(btn: HTMLButtonElement) {
  if (!assignment) return;
  const players = assignment.players.map((noteNames, idx) => playerPdfSpec(idx, noteNames));

  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Generating…';
  setStatus(`Rendering ${players.length} scores — this can take a moment…`);
  const res = await bell.exportAllPdf({
    players,
    suggestedName: `${stem()}_all_players.pdf`,
  });
  btn.disabled = false;
  btn.textContent = prev;

  if (res.canceled) { setStatus(''); return; }
  if (res.error) {
    setStatus(res.needMuseScore
      ? 'PDF export needs MuseScore 4 — install it from musescore.org, then try again.'
      : `PDF error: ${res.error}`, 'bad');
  } else {
    setStatus(`Saved ${res.count} scores to ${res.savedTo}`, 'good');
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
async function chooseFile() {
  const path = await bell.openFile();
  if (path) loadFile(path);
}

$('btn-choose').addEventListener('click', chooseFile);
$('btn-change').addEventListener('click', chooseFile);

($('pdf-color-notes') as HTMLInputElement).addEventListener('change', (e) => {
  pdfColorNotes = (e.target as HTMLInputElement).checked;
});
($('pdf-show-arrows') as HTMLInputElement).addEventListener('change', (e) => {
  pdfShowArrows = (e.target as HTMLInputElement).checked;
});
($('pdf-bells-used') as HTMLInputElement).addEventListener('change', (e) => {
  pdfBellsUsedHeader = (e.target as HTMLInputElement).checked;
});

$('players-dec').addEventListener('click', () => setPlayers(nPlayers - 1));
$('players-inc').addEventListener('click', () => setPlayers(nPlayers + 1));
$('n-players').addEventListener('change', (e) => setPlayers(parseInt((e.target as HTMLInputElement).value, 10)));

$('min-count').addEventListener('input', (e) => {
  const raw = (e.target as HTMLInputElement).value.trim();
  minCount = raw === '' ? null : (Number.isNaN(parseInt(raw, 10)) ? null : parseInt(raw, 10));
  recompute();
});
$('min-gap').addEventListener('input', (e) => {
  const raw = (e.target as HTMLInputElement).value.trim();
  minGapBeats = raw === '' ? null : (Number.isNaN(parseFloat(raw)) ? null : parseFloat(raw));
  recompute();
});
($('two-hand') as HTMLInputElement).addEventListener('change', (e) => {
  twoHand = (e.target as HTMLInputElement).checked;
  recompute();
});

// Drag-and-drop a .mscz onto the empty state.
const dz = $('dropzone');
const stopEvent = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { stopEvent(e as DragEvent); dz.classList.add('drag-over'); }));
['dragleave', 'dragend'].forEach(ev => dz.addEventListener(ev, (e) => { stopEvent(e as DragEvent); dz.classList.remove('drag-over'); }));
dz.addEventListener('drop', (e) => {
  stopEvent(e as DragEvent);
  dz.classList.remove('drag-over');
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.mscz')) { showEmptyError('Please drop a MuseScore .mscz file.'); return; }
  try {
    const path = bell.pathForFile(file);
    if (path) loadFile(path);
  } catch {
    showEmptyError('Could not read that file — try the Choose file button.');
  }
});
// Prevent the window from navigating if a file is dropped outside the zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

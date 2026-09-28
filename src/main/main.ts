import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import started from 'electron-squirrel-startup';

import { PDFDocument } from 'pdf-lib';

import { parseNotes, getDivision, notesByPitch, debugParse } from '../core/mscz-parser';
import { assignPlayers, Assignment } from '../core/assigner';
import { colorPlayerScore } from '../core/pdf-color';
import { buildBellsUsedScore } from '../core/bells-used';
import { renderPdf, renderTrimmedPng } from './mscore';
import { addBellsUsedBand } from './pdf-compose';
import { buildCsv } from './csv';

if (started) app.quit();

// In-memory state (lives for the session, cleared on restart)
const loadedFiles = new Map<string, Uint8Array>();   // filePath -> mscz bytes
const pdfCache = new Map<string, Buffer>();            // `${filePath}:${playerIdx}` -> pdf bytes
let currentAssignment: Assignment | null = null;
let currentFilePath: string | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: '#ececec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Handbell Manager',
    titleBarStyle: 'hiddenInset',
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('bell:openFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open MuseScore File',
    filters: [{ name: 'MuseScore', extensions: ['mscz'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('bell:parse', async (_event, filePath: string) => {
  try {
    let bytes = loadedFiles.get(filePath);
    if (!bytes) {
      bytes = new Uint8Array(fs.readFileSync(filePath));
      loadedFiles.set(filePath, bytes);
    }
    const events = parseNotes(bytes);
    if (!events.length) {
      const diag = debugParse(bytes);
      return { error: `No notes found in that file.\n\n${diag}` };
    }
    const division = getDivision(bytes);
    const notes = notesByPitch(events);
    currentFilePath = filePath;
    return { division, notes, distinctCount: notes.length, filename: path.basename(filePath) };
  } catch (e: unknown) {
    return { error: `Could not read that file: ${(e as Error).message}` };
  }
});

ipcMain.handle('bell:assign', async (_event, args: {
  filePath: string;
  nPlayers: number;
  pins: Record<string, number>;
  playerNames: string[];
  minCount: number | null;
  minGapBeats: number | null;
  division: number;
  handsPerPlayer: number;
}) => {
  try {
    let bytes = loadedFiles.get(args.filePath);
    if (!bytes) {
      bytes = new Uint8Array(fs.readFileSync(args.filePath));
      loadedFiles.set(args.filePath, bytes);
    }
    const events = parseNotes(bytes);
    const assignment = assignPlayers(events, args.nPlayers, {
      pins: args.pins,
      playerNames: args.playerNames,
      minCount: args.minCount ?? undefined,
      minGapBeats: args.minGapBeats ?? undefined,
      division: args.division,
      handsPerPlayer: args.handsPerPlayer,
    });
    currentAssignment = assignment;
    pdfCache.clear();
    return { assignment };
  } catch (e: unknown) {
    return { error: (e as Error).message };
  }
});

interface PlayerPdfSpec {
  filePath: string;
  playerIdx: number;
  noteNames: string[];
  playerName?: string;
  bellColors?: Record<string, string>;
  colorNotes?: boolean;
  showArrows?: boolean;
  bellsUsedHeader?: boolean;   // default true
}

type PlayerPdfResult =
  | { ok: true; pdfBytes: Buffer }
  | { ok: false; error: string; needMuseScore?: boolean };

/** Render (or reuse a cached) colored PDF for a single player. */
async function renderPlayerPdf(spec: PlayerPdfSpec): Promise<PlayerPdfResult> {
  const colorSig = spec.bellColors
    ? Object.keys(spec.bellColors).sort().map(k => `${k}:${spec.bellColors![k]}`).join(',')
    : '';
  const header = spec.bellsUsedHeader !== false;
  const cacheKey = `${spec.filePath}:${spec.playerIdx}:${spec.playerName ?? ''}:${colorSig}:${spec.colorNotes ?? true}:${spec.showArrows ?? true}:${header}`;
  const cached = pdfCache.get(cacheKey);
  if (cached) return { ok: true, pdfBytes: cached };

  let bytes = loadedFiles.get(spec.filePath);
  if (!bytes) {
    bytes = new Uint8Array(fs.readFileSync(spec.filePath));
    loadedFiles.set(spec.filePath, bytes);
  }
  const colored = colorPlayerScore(bytes, new Set(spec.noteNames), {
    playerName: spec.playerName,
    bellColors: spec.bellColors,
    colorNotes: spec.colorNotes,
    showArrows: spec.showArrows,
  });
  const rendered = renderPdf(colored.mscz);
  if (rendered.ok === false) {
    return { ok: false, error: rendered.error, needMuseScore: rendered.needMuseScore };
  }

  // Stamp the "bells used" color-key strip onto page 1. It's a nice-to-have, so
  // a failure to render/composite it falls back to the plain colored score.
  let pdfBytes: Buffer = rendered.pdfBytes;
  if (header && colored.orderedNames.length > 0) {
    const stripMscz = buildBellsUsedScore(colored.orderedNames, colored.colorByName);
    const strip = renderTrimmedPng(stripMscz);
    if (strip.ok) {
      try {
        const banded = await addBellsUsedBand(
          rendered.pdfBytes, strip.pngBytes, colored.orderedNames.length,
        );
        pdfBytes = Buffer.from(banded);
      } catch { /* keep the un-banded score */ }
    }
  }

  pdfCache.set(cacheKey, pdfBytes);
  return { ok: true, pdfBytes };
}

ipcMain.handle('bell:exportPdf', async (_event, args: PlayerPdfSpec & { suggestedName: string }) => {
  const saveResult = await dialog.showSaveDialog({
    title: 'Save Player PDF',
    defaultPath: args.suggestedName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

  try {
    const rendered = await renderPlayerPdf(args);
    if (rendered.ok === false) {
      return { error: rendered.error, needMuseScore: rendered.needMuseScore };
    }
    fs.writeFileSync(saveResult.filePath, rendered.pdfBytes);
    shell.showItemInFolder(saveResult.filePath);
    return { savedTo: saveResult.filePath };
  } catch (e: unknown) {
    return { error: (e as Error).message };
  }
});

ipcMain.handle('bell:exportAllPdf', async (_event, args: {
  players: PlayerPdfSpec[];
  suggestedName: string;
}) => {
  if (!args.players.length) return { error: 'No players to export.' };

  const saveResult = await dialog.showSaveDialog({
    title: 'Save All Player PDFs',
    defaultPath: args.suggestedName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

  try {
    const merged = await PDFDocument.create();
    for (const spec of args.players) {
      const rendered = await renderPlayerPdf(spec);
      if (rendered.ok === false) {
        return { error: rendered.error, needMuseScore: rendered.needMuseScore };
      }
      const src = await PDFDocument.load(rendered.pdfBytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    const mergedBytes = await merged.save();
    fs.writeFileSync(saveResult.filePath, mergedBytes);
    shell.showItemInFolder(saveResult.filePath);
    return { savedTo: saveResult.filePath, count: args.players.length };
  } catch (e: unknown) {
    return { error: (e as Error).message };
  }
});

ipcMain.handle('bell:exportCsv', async (_event, args: {
  assignment: Assignment;
  suggestedName: string;
}) => {
  const saveResult = await dialog.showSaveDialog({
    title: 'Save Assignment CSV',
    defaultPath: args.suggestedName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { canceled: true };
  try {
    const csv = buildCsv(args.assignment);
    fs.writeFileSync(saveResult.filePath, csv, 'utf8');
    shell.showItemInFolder(saveResult.filePath);
    return { savedTo: saveResult.filePath };
  } catch (e: unknown) {
    return { error: (e as Error).message };
  }
});

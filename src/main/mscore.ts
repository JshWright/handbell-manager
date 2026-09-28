/**
 * Locate the MuseScore CLI and shell out to render a PDF.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MSCORE_CANDIDATES = [
  '/usr/local/bin/mscore',
  '/opt/homebrew/bin/mscore',
  '/Applications/MuseScore 4.app/Contents/MacOS/mscore',
];

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function findMscoreBinary(): string | null {
  const fromPath = findOnPath('mscore');
  if (fromPath) return fromPath;
  for (const c of MSCORE_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export type PdfResult =
  | { ok: true; pdfBytes: Buffer }
  | { ok: false; needMuseScore?: true; error: string };

// Standard macOS location for the MuseSampler instrument library (installed by
// Muse Hub). MuseScore 4 boots its audio engine even for a headless PDF export,
// and if MUSESAMPLER_INSTRUMENT_FOLDER is undefined it can throw
// ("Instrument folder environment variable not defined!") and crash mid-launch.
// Defining it — to the real folder when present, otherwise any valid directory —
// silences that guard. PDF rendering doesn't need the instruments themselves.
const MUSESAMPLER_INSTRUMENT_DIRS = [
  '/Library/Application Support/MuseSampler/Instruments',
];

/** Environment for the mscore child, with the sampler folder defined. */
function mscoreEnv(fallbackDir: string): NodeJS.ProcessEnv {
  const instrumentDir =
    MUSESAMPLER_INSTRUMENT_DIRS.find(d => fs.existsSync(d)) ?? fallbackDir;
  // NB: don't force QT_QPA_PLATFORM=offscreen — MuseScore's bundled Qt ships
  // only the native platform plugin (cocoa on macOS), so forcing offscreen
  // prevents it from launching at all. The default platform renders PDFs fine.
  return {
    ...process.env,
    MUSESAMPLER_INSTRUMENT_FOLDER:
      process.env.MUSESAMPLER_INSTRUMENT_FOLDER ?? instrumentDir,
  };
}

export function renderPdf(coloredMsczBytes: Uint8Array): PdfResult {
  const mscore = findMscoreBinary();
  if (!mscore) {
    return {
      ok: false,
      needMuseScore: true,
      error:
        'PDF export needs MuseScore 4. Download it free at musescore.org, ' +
        'then try again.',
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handbell-manager-'));
  const msczPath = path.join(tmpDir, 'score.mscz');
  const pdfPath = path.join(tmpDir, 'out.pdf');
  const env = mscoreEnv(tmpDir);
  try {
    fs.writeFileSync(msczPath, coloredMsczBytes);

    // MuseScore 4's audio-engine startup can crash intermittently (a mutex race
    // in MuseSampler). Since it's a race, a retry usually succeeds — try a few
    // times before giving up, keeping the last failure's detail for the message.
    const ATTEMPTS = 3;
    let lastDetail = 'unknown error';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      fs.rmSync(pdfPath, { force: true });
      const result = spawnSync(mscore, ['-o', pdfPath, msczPath], {
        timeout: 60_000,
        encoding: 'buffer',
        env,
      });
      if (result.error) {
        return { ok: false, error: `Couldn't launch MuseScore: ${result.error.message}` };
      }
      if (result.status === 0 && fs.existsSync(pdfPath)) {
        return { ok: true, pdfBytes: fs.readFileSync(pdfPath) };
      }
      lastDetail =
        (result.stderr ? result.stderr.toString('utf8', 0, 500) : '') ||
        (result.stdout ? result.stdout.toString('utf8', 0, 500) : '') ||
        'unknown error';
    }
    return {
      ok: false,
      error: `MuseScore PDF export failed after ${ATTEMPTS} attempts: ${lastDetail.trim()}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export type PngResult =
  | { ok: true; pngBytes: Buffer }
  | { ok: false; needMuseScore?: true; error: string };

/**
 * Render a (small, single-system) score to a PNG trimmed tight to its content.
 * Used for the "bells used" header strip. `mscore --trim-image <margin>` crops
 * whitespace; MuseScore writes the first page as `out-1.png` (or `out.png`).
 */
export function renderTrimmedPng(msczBytes: Uint8Array, dpi = 300, margin = 6): PngResult {
  const mscore = findMscoreBinary();
  if (!mscore) {
    return {
      ok: false,
      needMuseScore: true,
      error:
        'PDF export needs MuseScore 4. Download it free at musescore.org, ' +
        'then try again.',
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handbell-manager-strip-'));
  const msczPath = path.join(tmpDir, 'strip.mscz');
  const pngArg = path.join(tmpDir, 'out.png');
  const candidates = [path.join(tmpDir, 'out-1.png'), pngArg];
  const env = mscoreEnv(tmpDir);
  try {
    fs.writeFileSync(msczPath, msczBytes);

    const ATTEMPTS = 3;
    let lastDetail = 'unknown error';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      for (const c of candidates) fs.rmSync(c, { force: true });
      const result = spawnSync(
        mscore,
        ['--trim-image', String(margin), '-r', String(dpi), '-o', pngArg, msczPath],
        { timeout: 60_000, encoding: 'buffer', env },
      );
      if (result.error) {
        return { ok: false, error: `Couldn't launch MuseScore: ${result.error.message}` };
      }
      const out = candidates.find(c => fs.existsSync(c));
      if (result.status === 0 && out) {
        return { ok: true, pngBytes: fs.readFileSync(out) };
      }
      lastDetail =
        (result.stderr ? result.stderr.toString('utf8', 0, 500) : '') ||
        (result.stdout ? result.stdout.toString('utf8', 0, 500) : '') ||
        'unknown error';
    }
    return {
      ok: false,
      error: `MuseScore image export failed after ${ATTEMPTS} attempts: ${lastDetail.trim()}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

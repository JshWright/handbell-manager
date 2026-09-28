import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Assignment } from '../core/assigner';

export interface NoteInfo { name: string; count: number }
export interface ParseResult { division: number; notes: NoteInfo[]; distinctCount: number; filename: string }
export interface AssignArgs {
  filePath: string;
  nPlayers: number;
  pins: Record<string, number>;
  playerNames: string[];
  minCount: number | null;
  minGapBeats: number | null;
  division: number;
  handsPerPlayer: number;
}
export interface ExportPdfArgs {
  filePath: string;
  playerIdx: number;
  noteNames: string[];
  suggestedName: string;
  playerName?: string;
  bellColors?: Record<string, string>;
  colorNotes?: boolean;
  showArrows?: boolean;
  bellsUsedHeader?: boolean;
}
export interface PlayerPdfSpec {
  filePath: string;
  playerIdx: number;
  noteNames: string[];
  playerName?: string;
  bellColors?: Record<string, string>;
  colorNotes?: boolean;
  showArrows?: boolean;
  bellsUsedHeader?: boolean;
}
export interface ExportAllPdfArgs {
  players: PlayerPdfSpec[];
  suggestedName: string;
}
export interface ExportCsvArgs {
  assignment: Assignment;
  suggestedName: string;
}

contextBridge.exposeInMainWorld('bell', {
  openFile: (): Promise<string | null> => ipcRenderer.invoke('bell:openFile'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  parse: (filePath: string): Promise<ParseResult | { error: string }> =>
    ipcRenderer.invoke('bell:parse', filePath),
  assign: (args: AssignArgs): Promise<{ assignment: Assignment } | { error: string }> =>
    ipcRenderer.invoke('bell:assign', args),
  exportPdf: (args: ExportPdfArgs): Promise<{ savedTo?: string; canceled?: boolean; error?: string; needMuseScore?: boolean }> =>
    ipcRenderer.invoke('bell:exportPdf', args),
  exportAllPdf: (args: ExportAllPdfArgs): Promise<{ savedTo?: string; count?: number; canceled?: boolean; error?: string; needMuseScore?: boolean }> =>
    ipcRenderer.invoke('bell:exportAllPdf', args),
  exportCsv: (args: ExportCsvArgs): Promise<{ savedTo?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('bell:exportCsv', args),
});

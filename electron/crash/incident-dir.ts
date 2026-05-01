// electron/crash/incident-dir.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from 'ulid';

export interface IncidentMeta {
  schemaVersion: 1;
  incidentId: string;
  ts: string;
  surface: 'main' | 'renderer' | 'gpu' | 'helper' | 'daemon-exit' | 'daemon-uncaught' | 'daemon-boot-crash';
  appVersion: string;
  electronVersion: string;
  os: { platform: string; release: string; arch: string };
  frontend?: { lastSentryEventId?: string; logFile?: string; logRange?: string };
  backend?: {
    exitCode: number | null;
    signal: string | null;
    bootNonce?: string;
    lastTraceId?: string;
    lastHealthzAgoMs: number | null;
    markerPresent: boolean;
  };
}

export function resolveCrashRoot(localAppData?: string): string {
  if (process.platform === 'win32') {
    const base = localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'CCSM', 'crashes');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CCSM', 'crashes');
  }
  return path.join(os.homedir(), '.local', 'share', 'CCSM', 'crashes');
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }
function tsStamp(d = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

export function createIncidentDir(root: string, id: string = ulid()): string {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `${tsStamp()}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeMeta(dir: string, meta: IncidentMeta): void {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export function writeReadme(dir: string, summary: string): void {
  fs.writeFileSync(path.join(dir, 'README.txt'), summary, 'utf8');
}

// tests/electron/crash/incident-dir.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveCrashRoot, createIncidentDir, writeMeta, IncidentMeta } from '../../../electron/crash/incident-dir';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-crash-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('incident-dir', () => {
  it('createIncidentDir returns dir under root with timestamped+ulid name', () => {
    const dir = createIncidentDir(tmp);
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(tmp);
    expect(path.basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it('writeMeta writes meta.json with schemaVersion 1', () => {
    const dir = createIncidentDir(tmp);
    const meta: IncidentMeta = {
      schemaVersion: 1, incidentId: '01ARZ3',
      ts: '2026-05-01T16:18:03.412Z', surface: 'daemon-exit',
      appVersion: '0.3.0', electronVersion: '41.3.0',
      os: { platform: 'win32', release: '10.0.26200', arch: 'x64' },
    };
    writeMeta(dir, meta);
    const read = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(read.schemaVersion).toBe(1);
    expect(read.surface).toBe('daemon-exit');
  });

  it('resolveCrashRoot returns OS-appropriate path', () => {
    const root = resolveCrashRoot();
    expect(root).toContain('CCSM');
    expect(root).toContain('crashes');
  });
});

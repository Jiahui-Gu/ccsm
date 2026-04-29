import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({}));
vi.mock('../../agent/list-models-from-settings', () => ({
  listModelsFromSettings: async () => ({ models: [] }),
  readDefaultModelFromSettings: async () => null,
}));
vi.mock('../../security/ipcGuards', () => ({
  fromMainFrame: () => true,
}));

import { readConnectionView } from '../systemIpc';

let tmpDir = '';
let tmpFile = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-systemIpc-'));
  tmpFile = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('readConnectionView', () => {
  it('returns env-only view when settings.json is missing', () => {
    const v = readConnectionView(
      {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_MODEL: 'env-model',
        ANTHROPIC_AUTH_TOKEN: 'tok',
      } as NodeJS.ProcessEnv,
      tmpFile,
    );
    expect(v.baseUrl).toBe('https://api.example.com');
    expect(v.model).toBe('env-model');
    expect(v.hasAuthToken).toBe(true);
  });

  it('prefers settings.json values over env when both present', () => {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        model: 'settings-model',
        env: {
          ANTHROPIC_BASE_URL: 'https://settings.example.com',
          ANTHROPIC_AUTH_TOKEN: 'settings-tok',
        },
      }),
      'utf8',
    );
    const v = readConnectionView(
      {
        ANTHROPIC_BASE_URL: 'https://env.example.com',
        ANTHROPIC_MODEL: 'env-model',
      } as NodeJS.ProcessEnv,
      tmpFile,
    );
    expect(v.baseUrl).toBe('https://settings.example.com');
    expect(v.model).toBe('settings-model');
    expect(v.hasAuthToken).toBe(true);
  });

  it('returns nulls + false when neither settings nor env have anything', () => {
    const v = readConnectionView({} as NodeJS.ProcessEnv, tmpFile);
    expect(v).toEqual({ baseUrl: null, model: null, hasAuthToken: false });
  });

  it('survives malformed JSON by falling through to env', () => {
    fs.writeFileSync(tmpFile, '{not json', 'utf8');
    const v = readConnectionView(
      { ANTHROPIC_BASE_URL: 'https://env.example.com' } as NodeJS.ProcessEnv,
      tmpFile,
    );
    expect(v.baseUrl).toBe('https://env.example.com');
  });

  it('treats whitespace-only env tokens as missing', () => {
    const v = readConnectionView(
      {
        ANTHROPIC_AUTH_TOKEN: '   ',
        ANTHROPIC_API_KEY: '',
      } as NodeJS.ProcessEnv,
      tmpFile,
    );
    expect(v.hasAuthToken).toBe(false);
  });

  it('reverse-verify: hasAuthToken stays false when no source provides one', () => {
    // Settings file present but with no auth fields → still false. Catches
    // a regression where any-settings-present accidentally short-circuited
    // to true.
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ model: 'm', env: {} }),
      'utf8',
    );
    const v = readConnectionView({} as NodeJS.ProcessEnv, tmpFile);
    expect(v.hasAuthToken).toBe(false);
  });
});

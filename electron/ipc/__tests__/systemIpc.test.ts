import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({}));
let listModelsImpl: () => Promise<{ models: unknown[] }> = async () => ({
  models: [],
});
vi.mock('../../agent/list-models-from-settings', () => ({
  listModelsFromSettings: () => listModelsImpl(),
  readDefaultModelFromSettings: async () => null,
}));
vi.mock('../../security/ipcGuards', () => ({
  fromMainFrame: () => true,
}));

import { readConnectionView, handleModelsList } from '../systemIpc';

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

describe('handleModelsList', () => {
  beforeEach(() => {
    listModelsImpl = async () => ({ models: [] });
  });

  it('returns the models from settings on success', async () => {
    listModelsImpl = async () => ({
      models: [{ id: 'foo', label: 'Foo' }],
    });
    const result = await handleModelsList();
    expect(result).toEqual([{ id: 'foo', label: 'Foo' }]);
  });

  // Audit risk #10 (tech-debt-03-errors.md): malformed settings.json must
  // not propagate as an opaque IPC rejection — Settings pane should show
  // an empty list, not a bridge crash. Reverse-verify: remove the try/catch
  // in handleModelsList → this test FAILS with an uncaught throw.
  it('returns [] and logs when listModelsFromSettings throws (audit risk #10)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    listModelsImpl = async () => {
      throw new SyntaxError('Unexpected token } in JSON at position 17');
    };
    const result = await handleModelsList();
    expect(result).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

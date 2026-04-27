import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listModelsFromSettings,
  FALLBACK_MODELS,
} from '../list-models-from-settings';
import { CLI_PICKER_MODELS } from '../cli-picker-models';

async function mkTmpDir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'agentory-list-models-test-'));
}

async function writeSettings(dir: string, body: unknown): Promise<void> {
  await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify(body), 'utf8');
}

describe('listModelsFromSettings', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkTmpDir();
  });

  afterEach(async () => {
    await fsp.rm(configDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns cli-picker + fallback when settings file does not exist', async () => {
    const missingDir = path.join(configDir, 'does-not-exist');
    const res = await listModelsFromSettings({ configDir: missingDir, env: {} });
    expect(res.ok).toBe(true);
    const ids = res.models.map((m) => m.id);
    // CLI picker entries appear first, then fallback (minus any already
    // contributed by cli-picker — but the v2.1.114 picker shares no ids with
    // the fallback triple, so all of both are present).
    expect(ids).toEqual([
      ...CLI_PICKER_MODELS.map((m) => m.id),
      ...FALLBACK_MODELS,
    ]);
    const sources = new Set(res.models.map((m) => m.source));
    expect(sources).toEqual(new Set(['cli-picker', 'fallback']));
  });

  it('does not throw on malformed JSON; returns cli-picker + fallback only', async () => {
    await fsp.writeFile(path.join(configDir, 'settings.json'), '{not valid', 'utf8');
    const res = await listModelsFromSettings({ configDir, env: {} });
    expect(res.ok).toBe(true);
    const ids = res.models.map((m) => m.id);
    expect(ids).toEqual([
      ...CLI_PICKER_MODELS.map((m) => m.id),
      ...FALLBACK_MODELS,
    ]);
  });

  it('picks up settings.model as source=settings', async () => {
    await writeSettings(configDir, { model: 'opus[1m]' });
    const res = await listModelsFromSettings({ configDir, env: {} });
    const top = res.models[0];
    expect(top.id).toBe('opus[1m]');
    expect(top.source).toBe('settings');
  });

  it('picks up settings.env hint vars as source=settings', async () => {
    await writeSettings(configDir, {
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
        ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5-20251001',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      },
    });
    const res = await listModelsFromSettings({ configDir, env: {} });
    const ids = res.models.filter((m) => m.source === 'settings').map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'claude-opus-4-7',
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-6',
      ]),
    );
  });

  it('process.env hint vars not present in settings get source=env', async () => {
    await writeSettings(configDir, {});
    const res = await listModelsFromSettings({
      configDir,
      env: { ANTHROPIC_MODEL: 'process-env-only-model' },
    });
    const m = res.models.find((x) => x.id === 'process-env-only-model');
    expect(m?.source).toBe('env');
  });

  it('settings.env wins source-tag when same id appears in process.env (first-source-wins, settings is added first)', async () => {
    // Same id in both: since settings is collected first, it keeps the
    // 'settings' tag — the test name documents the precedence rule.
    await writeSettings(configDir, {
      env: { ANTHROPIC_MODEL: 'shared-id' },
    });
    const res = await listModelsFromSettings({
      configDir,
      env: { ANTHROPIC_MODEL: 'shared-id' },
    });
    const matches = res.models.filter((m) => m.id === 'shared-id');
    expect(matches.length).toBe(1);
    expect(matches[0].source).toBe('settings');
  });

  it('manualModelIds appear with source=manual', async () => {
    await writeSettings(configDir, {});
    const res = await listModelsFromSettings({
      configDir,
      env: {},
      manualModelIds: ['custom-x', 'custom-y'],
    });
    const x = res.models.find((m) => m.id === 'custom-x');
    const y = res.models.find((m) => m.id === 'custom-y');
    expect(x?.source).toBe('manual');
    expect(y?.source).toBe('manual');
  });

  it('dedupes across all sources; first-source-wins (settings > env > manual > fallback)', async () => {
    await writeSettings(configDir, { model: 'claude-opus-4-7' });
    const res = await listModelsFromSettings({
      configDir,
      env: { ANTHROPIC_MODEL: 'claude-opus-4-7' }, // dup
      manualModelIds: ['claude-opus-4-7'], // dup
    });
    const matches = res.models.filter((m) => m.id === 'claude-opus-4-7');
    expect(matches.length).toBe(1);
    expect(matches[0].source).toBe('settings');
  });

  it('always includes fallback models, but tagged as fallback only if not seen earlier', async () => {
    await writeSettings(configDir, { model: 'claude-opus-4-7' }); // overlaps fallback
    const res = await listModelsFromSettings({ configDir, env: {} });
    const opus = res.models.find((m) => m.id === 'claude-opus-4-7');
    expect(opus?.source).toBe('settings'); // not 'fallback' — first source wins
    // The other two fallbacks still appear:
    const sonnet = res.models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.source).toBe('fallback');
  });

  it('skips empty / whitespace ids', async () => {
    await writeSettings(configDir, {
      model: '   ',
      env: { ANTHROPIC_MODEL: '' },
    });
    const res = await listModelsFromSettings({
      configDir,
      env: {},
      manualModelIds: ['', '   ', 'real-id'],
    });
    expect(res.models.find((m) => m.id === 'real-id')?.source).toBe('manual');
    expect(res.models.find((m) => m.id === '')).toBeUndefined();
    expect(res.models.find((m) => m.id === '   ')).toBeUndefined();
  });

  it('insertion order: settings → env → manual → cli-picker → env-override → fallback', async () => {
    await writeSettings(configDir, {
      model: 'from-settings-1',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'from-settings-2' },
    });
    const res = await listModelsFromSettings({
      configDir,
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env-1',
        // env-override tier var (also surfaces via 'env' source for the same
        // id; first-write-wins keeps it as 'env'). Use a distinct tier var so
        // we get a separate 'env-override' entry.
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'from-haiku-override',
      },
      manualModelIds: ['from-manual-1'],
    });
    const ids = res.models.map((m) => m.id);
    const idx = (id: string): number => ids.indexOf(id);
    expect(idx('from-settings-1')).toBeLessThan(idx('from-env-1'));
    expect(idx('from-settings-2')).toBeLessThan(idx('from-env-1'));
    expect(idx('from-env-1')).toBeLessThan(idx('from-manual-1'));
    expect(idx('from-manual-1')).toBeLessThan(idx(CLI_PICKER_MODELS[0].id));
    expect(idx(CLI_PICKER_MODELS[0].id)).toBeLessThan(idx(FALLBACK_MODELS[0]));
  });

  it('CLI picker hardcoded ids appear in the result with source=cli-picker', async () => {
    const res = await listModelsFromSettings({ configDir, env: {} });
    for (const expected of CLI_PICKER_MODELS) {
      const found = res.models.find((m) => m.id === expected.id);
      expect(found).toBeDefined();
      expect(found?.source).toBe('cli-picker');
    }
  });

  it('settings model wins source-tag when same id appears in cli-picker', async () => {
    // 'sonnet' is a hardcoded picker entry — but if the user also has it as
    // their settings.json model, settings should win the tag (precedence).
    await writeSettings(configDir, { model: 'sonnet' });
    const res = await listModelsFromSettings({ configDir, env: {} });
    const matches = res.models.filter((m) => m.id === 'sonnet');
    expect(matches.length).toBe(1);
    expect(matches[0].source).toBe('settings');
  });

  it('tier env vars are claimed by the general env pass (env wins over env-override by precedence)', async () => {
    // ANTHROPIC_DEFAULT_<TIER>_MODEL is scanned by both the general env pass
    // (as a known model-key) and the per-tier env-override pass. First-write
    // -wins → 'env'. The env-override pass exists for richer label/description
    // metadata via companion vars; its source-tag only ever surfaces if the
    // general env scan ever stops covering the tier keys. Documented here so
    // a future reorganisation doesn't silently break the precedence rule.
    const res = await listModelsFromSettings({
      configDir,
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-sonnet' },
    });
    const m = res.models.find((x) => x.id === 'shared-sonnet');
    expect(m?.source).toBe('env');
  });
});

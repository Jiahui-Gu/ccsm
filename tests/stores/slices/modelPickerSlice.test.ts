import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createModelPickerSlice } from '../../../src/stores/slices/modelPickerSlice';
import type { RootStore } from '../../../src/stores/slices/types';

function harness() {
  let state: Partial<RootStore> = {};
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const slice = createModelPickerSlice(set, get);
  state = { ...state, ...slice };
  return { state: () => state, slice };
}

describe('modelPickerSlice', () => {
  beforeEach(() => {
    // Each test installs its own ccsm IPC bridge; default to undefined so a
    // missing bridge can be exercised explicitly.
    (window as unknown as { ccsm?: unknown }).ccsm = undefined;
  });
  afterEach(() => {
    (window as unknown as { ccsm?: unknown }).ccsm = undefined;
  });

  it('initial state', () => {
    const h = harness();
    const s = h.state();
    expect(s.models).toEqual([]);
    expect(s.modelsLoaded).toBe(false);
    expect(s.connection).toBeNull();
    expect(s.claudeSettingsDefaultModel).toBeNull();
    expect(s.installerCorrupt).toBe(false);
  });

  it('setInstallerCorrupt toggles the banner flag', () => {
    const h = harness();
    h.slice.setInstallerCorrupt(true);
    expect(h.state().installerCorrupt).toBe(true);
    h.slice.setInstallerCorrupt(false);
    expect(h.state().installerCorrupt).toBe(false);
  });

  it('loadModels marks loaded even when the bridge is missing', async () => {
    const h = harness();
    await h.slice.loadModels();
    expect(h.state().modelsLoaded).toBe(true);
    expect(h.state().models).toEqual([]);
  });

  it('loadModels populates from the IPC bridge', async () => {
    const list = [
      { id: 'sonnet', source: 'settings' as const },
      { id: 'opus', source: 'cli-picker' as const },
    ];
    (window as unknown as { ccsm: unknown }).ccsm = {
      models: { list: vi.fn(async () => list) },
    };
    const h = harness();
    await h.slice.loadModels();
    expect(h.state().models).toEqual(list);
    expect(h.state().modelsLoaded).toBe(true);
  });

  it('loadModels swallows IPC failures and still marks loaded', async () => {
    (window as unknown as { ccsm: unknown }).ccsm = {
      models: { list: vi.fn(async () => { throw new Error('boom'); }) },
    };
    const h = harness();
    await h.slice.loadModels();
    expect(h.state().modelsLoaded).toBe(true);
    expect(h.state().models).toEqual([]);
  });

  it('loadConnection populates connection on success', async () => {
    const conn = {
      endpointKind: 'anthropic' as const,
      baseUrl: '',
      keyMasked: 'sk-***',
      model: 'sonnet-4.7',
      profile: 'default',
    };
    (window as unknown as { ccsm: unknown }).ccsm = {
      connection: { read: vi.fn(async () => conn) },
    };
    const h = harness();
    await h.slice.loadConnection();
    expect(h.state().connection).toEqual(conn);
  });

  it('loadConnection no-ops when bridge is missing', async () => {
    const h = harness();
    await h.slice.loadConnection();
    expect(h.state().connection).toBeNull();
  });

  it('loadConnection swallows IPC failures (connection stays null)', async () => {
    (window as unknown as { ccsm: unknown }).ccsm = {
      connection: { read: vi.fn(async () => { throw new Error('ipc'); }) },
    };
    const h = harness();
    await h.slice.loadConnection();
    expect(h.state().connection).toBeNull();
  });
});

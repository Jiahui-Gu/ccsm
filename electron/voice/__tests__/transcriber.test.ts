import { describe, it, expect, vi, beforeEach } from 'vitest';

// app.getAppPath / resourcesPath are read at module load via electron — mock it.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo' },
}));

describe('resolveModelPath', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CCSM_FORCE_PACKAGED;
  });

  it('resolves the repo-local path in dev', async () => {
    const { resolveModelPath } = await import('../transcriber');
    // dev: process.resourcesPath points into electron's own dir, so we
    // fall back to the app path's resources/models.
    const p = resolveModelPath();
    expect(p.replace(/\\/g, '/')).toContain('resources/models/ggml-small.bin');
  });
});

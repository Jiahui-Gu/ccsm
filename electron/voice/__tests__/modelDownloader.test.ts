import { describe, it, expect, vi, beforeEach } from 'vitest';

// modelDownloader pulls app/BrowserWindow from electron, writes to fs, and
// streams via stream/promises pipeline. Mock all three plus global fetch so
// the test stays in-memory and deterministic.

const sentMessages: Array<{ channel: string; payload: unknown }> = [];
const webContents = {
  send: (channel: string, payload: unknown) => sentMessages.push({ channel, payload }),
};

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
  BrowserWindow: { getAllWindows: () => [{ webContents }] },
}));

// In-memory fs: track files by normalized path with their byte size.
const files = new Map<string, number>();
function norm(p: string): string {
  return String(p).replace(/\\/g, '/');
}

const fsMock = {
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: (_chunk: Buffer, cb: (err?: Error | null) => void) => cb(null),
    end: (cb: () => void) => cb(),
  })),
  statSync: vi.fn((p: string) => {
    const size = files.get(norm(p));
    if (size === undefined) throw new Error('ENOENT');
    return { size };
  }),
  renameSync: vi.fn((from: string, to: string) => {
    const size = files.get(norm(from));
    if (size === undefined) throw new Error('ENOENT');
    files.delete(norm(from));
    files.set(norm(to), size);
  }),
  unlinkSync: vi.fn((p: string) => {
    files.delete(norm(p));
  }),
};
vi.mock('fs', () => ({ ...fsMock, default: fsMock }));

// pipeline(source, meter) — drive the meter's write() with the source's chunks
// (so the downloader's transferred-byte accounting + tmp-file size run), then
// final(). The meter writes into our fake fs createWriteStream, so we record
// the landed size onto the tmp path the meter is targeting.
const pipelineImpl = vi.fn();
vi.mock('stream/promises', () => ({
  pipeline: (...args: unknown[]) => pipelineImpl(...args),
  default: { pipeline: (...args: unknown[]) => pipelineImpl(...args) },
}));

// Build a Response-like with a body whose chunks we control.
function makeResponse(opts: {
  ok: boolean;
  status?: number;
  contentLength?: string | null;
  chunks?: Buffer[];
}) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    body: opts.ok ? { __chunks: opts.chunks ?? [] } : null,
    headers: { get: (k: string) => (k === 'content-length' ? opts.contentLength ?? null : null) },
  };
}

// Default pipeline behavior: pump body chunks through the meter, sizing the
// tmp file by total bytes written. The tmp path is closed over via a module
// variable set in run(); we recover it from the meter by tracking writes.
beforeEach(() => {
  vi.resetModules();
  files.clear();
  sentMessages.length = 0;
  pipelineImpl.mockReset();
  vi.unstubAllGlobals();
});

// A pipeline that feeds the response chunks into the meter and records the
// resulting tmp-file size. We infer the tmp path from the most recent
// downloading status broadcast is not reliable, so instead the meter's write
// callback path is what matters: we mirror the byte count into a holder and
// the test's fetch closure stamps the tmp path size directly.
function installPumpingPipeline(tmpHolder: { path: string | null }, total: number) {
  pipelineImpl.mockImplementation(async (source: { __chunks: Buffer[] }, meter: NodeJS.WritableStream) => {
    let written = 0;
    for (const chunk of source.__chunks) {
      await new Promise<void>((resolve, reject) =>
        meter.write(chunk, (err?: Error | null) => (err ? reject(err) : resolve())),
      );
      written += chunk.length;
    }
    await new Promise<void>((resolve) => meter.end(resolve));
    if (tmpHolder.path) files.set(norm(tmpHolder.path), total > 0 ? total : written);
  });
}

describe('modelDownloader.isTierDownloaded', () => {
  it('true only when the model file exists with non-zero size', async () => {
    const { isTierDownloaded } = await import('../modelDownloader');
    expect(isTierDownloaded('base')).toBe(false);
    files.set('/userData/models/ggml-base.bin', 0);
    expect(isTierDownloaded('base')).toBe(false);
    files.set('/userData/models/ggml-base.bin', 147951465);
    expect(isTierDownloaded('base')).toBe(true);
  });
});

describe('modelDownloader.downloadTier', () => {
  it('downloads from the primary, lands atomically, and broadcasts ready', async () => {
    const tmp = { path: null as string | null };
    installPumpingPipeline(tmp, 6);
    const fetchMock = vi.fn(async (url: string) => {
      // Capture the tmp path the downloader will write to by deriving it: the
      // downloader writes ggml-tiny.bin.download-<rand>; we don't know rand,
      // so stamp via renameSync source instead. Simpler: set tmp.path on first
      // statSync miss. Here we mark success by returning chunks.
      expect(url).toContain('huggingface.co');
      return makeResponse({ ok: true, contentLength: '6', chunks: [Buffer.from('abcdef')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { downloadTier } = await import('../modelDownloader');
    // The downloader picks a random tmp path; intercept renameSync to learn it.
    const fs = await import('fs');
    (fs.renameSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (from: string, to: string) => {
        files.set(norm(to), 6);
        files.delete(norm(from));
      },
    );
    // statSync must report the tmp size; pre-seed when createWriteStream runs.
    (fs.createWriteStream as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (p: string) => {
        tmp.path = p;
        return {
          write: (_c: Buffer, cb: (e?: Error | null) => void) => cb(null),
          end: (cb: () => void) => cb(),
        };
      },
    );

    const status = await downloadTier('tiny');
    expect(status).toEqual({ kind: 'ready', tier: 'tiny' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const ready = sentMessages.filter((m) => (m.payload as { kind: string }).kind === 'ready');
    expect(ready).toHaveLength(1);
  });

  it('falls back to the mirror when the primary fails', async () => {
    const tmp = { path: null as string | null };
    installPumpingPipeline(tmp, 6);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('huggingface.co')) return makeResponse({ ok: false, status: 503 });
      return makeResponse({ ok: true, contentLength: '6', chunks: [Buffer.from('abcdef')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { downloadTier } = await import('../modelDownloader');
    const fs = await import('fs');
    (fs.createWriteStream as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      tmp.path = p;
      return {
        write: (_c: Buffer, cb: (e?: Error | null) => void) => cb(null),
        end: (cb: () => void) => cb(),
      };
    });

    const status = await downloadTier('tiny');
    expect(status.kind).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('huggingface.co');
    expect(fetchMock.mock.calls[1][0]).toContain('hf-mirror.com');
  });

  it('rejects a truncated download (landed size != Content-Length) and tries the mirror', async () => {
    const tmp = { path: null as string | null };
    // Primary writes only 3 bytes but declares 6 → size mismatch.
    pipelineImpl.mockImplementationOnce(async (_s: unknown, meter: NodeJS.WritableStream) => {
      await new Promise<void>((r) => meter.write(Buffer.from('abc'), () => r()));
      await new Promise<void>((r) => meter.end(r));
      if (tmp.path) files.set(norm(tmp.path), 3);
    });
    installPumpingPipeline(tmp, 6); // mirror writes full 6
    const fetchMock = vi.fn(async () =>
      makeResponse({ ok: true, contentLength: '6', chunks: [Buffer.from('abcdef')] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { downloadTier } = await import('../modelDownloader');
    const fs = await import('fs');
    (fs.createWriteStream as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      tmp.path = p;
      return {
        write: (_c: Buffer, cb: (e?: Error | null) => void) => cb(null),
        end: (cb: () => void) => cb(),
      };
    });

    const status = await downloadTier('tiny');
    expect(status.kind).toBe('ready');
    // Both sources attempted; the partial was unlinked before the retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('returns an error status when all sources fail', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { downloadTier } = await import('../modelDownloader');
    const status = await downloadTier('tiny');
    expect(status.kind).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const errors = sentMessages.filter((m) => (m.payload as { kind: string }).kind === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('dedups concurrent requests for the same tier (single fetch round)', async () => {
    const tmp = { path: null as string | null };
    installPumpingPipeline(tmp, 6);
    const fetchMock = vi.fn(async () =>
      makeResponse({ ok: true, contentLength: '6', chunks: [Buffer.from('abcdef')] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { downloadTier } = await import('../modelDownloader');
    const fs = await import('fs');
    (fs.createWriteStream as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      tmp.path = p;
      return {
        write: (_c: Buffer, cb: (e?: Error | null) => void) => cb(null),
        end: (cb: () => void) => cb(),
      };
    });

    const [a, b] = await Promise.all([downloadTier('tiny'), downloadTier('tiny')]);
    expect(a).toBe(b); // same Promise resolution
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

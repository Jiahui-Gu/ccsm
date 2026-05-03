// Unit tests for `protocol-app.ts` — descriptor server logic.
//
// Spec ref: ch08 §4.1. We exercise the pure helpers + the handler factory
// without spawning Electron — handler is `(Request) => Promise<Response>`
// so a synthetic `Request` from undici is enough. The Electron registration
// helpers (`registerAppSchemeAsPrivileged`, `registerProtocolApp`) get a
// structural fake to assert the wiring.

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_SCHEME,
  BRIDGE_PENDING_SENTINEL,
  DESCRIPTOR_URL,
  type DescriptorV1,
  type ElectronProtocolLike,
  type ElectronSchemeRegistrarLike,
  createDescriptorHandler,
  descriptorPath,
  parseDescriptor,
  registerAppSchemeAsPrivileged,
  registerProtocolApp,
  rewriteDescriptorAddress,
} from '../../src/main/protocol-app.js';

const SAMPLE: DescriptorV1 = {
  version: 1,
  transport: 'KIND_UDS',
  address: '/run/ccsm/daemon.sock',
  tlsCertFingerprintSha256: null,
  supervisorAddress: '/run/ccsm/supervisor.sock',
  boot_id: '550e8400-e29b-41d4-a716-446655440000',
  daemon_pid: 1234,
  listener_addr: '/run/ccsm/daemon.sock',
  protocol_version: 1,
  bind_unix_ms: 1714600000000,
};

const SAMPLE_JSON = JSON.stringify(SAMPLE, null, 2);

// ---------------------------------------------------------------------------
// descriptorPath — per-OS layout (mirrors daemon paths.spec.ts fixtures)
// ---------------------------------------------------------------------------

describe('descriptorPath — per-OS layout (ch07 §2)', () => {
  it('win32 with %PROGRAMDATA% set uses it', () => {
    expect(descriptorPath('win32', { PROGRAMDATA: 'D:\\ProgramData' })).toBe(
      'D:\\ProgramData\\ccsm\\listener-a.json',
    );
  });

  it('win32 with empty %PROGRAMDATA% falls back to C:\\ProgramData', () => {
    expect(descriptorPath('win32', { PROGRAMDATA: '' })).toBe(
      'C:\\ProgramData\\ccsm\\listener-a.json',
    );
  });

  it('win32 with %PROGRAMDATA% unset falls back to C:\\ProgramData', () => {
    expect(descriptorPath('win32', {})).toBe(
      'C:\\ProgramData\\ccsm\\listener-a.json',
    );
  });

  it('darwin uses /Library/Application Support/ccsm', () => {
    expect(descriptorPath('darwin', {})).toBe(
      '/Library/Application Support/ccsm/listener-a.json',
    );
  });

  it('linux uses /var/lib/ccsm', () => {
    expect(descriptorPath('linux', {})).toBe(
      '/var/lib/ccsm/listener-a.json',
    );
  });

  it('freebsd / unrecognized POSIX fall through to the linux branch', () => {
    expect(descriptorPath('freebsd' as NodeJS.Platform, {})).toBe(
      '/var/lib/ccsm/listener-a.json',
    );
  });

  it('does not respect XDG_DATA_HOME on linux (ch07 §2 LOCKED)', () => {
    expect(
      descriptorPath('linux', { XDG_DATA_HOME: '/home/me/.local/share' }),
    ).toBe('/var/lib/ccsm/listener-a.json');
  });
});

// ---------------------------------------------------------------------------
// parseDescriptor — schema validation
// ---------------------------------------------------------------------------

describe('parseDescriptor', () => {
  it('round-trips a valid v1 descriptor', () => {
    expect(parseDescriptor(SAMPLE_JSON)).toEqual(SAMPLE);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseDescriptor('{not json')).toThrow(/JSON parse failed/);
  });

  it('rejects non-object root', () => {
    expect(() => parseDescriptor('"hello"')).toThrow(/must be a JSON object/);
    expect(() => parseDescriptor('null')).toThrow(/must be a JSON object/);
    expect(() => parseDescriptor('[]')).toThrow(/version must be 1/);
  });

  it('rejects wrong version (no schema-widening per ch03 §3.2)', () => {
    const bad = { ...SAMPLE, version: 2 };
    expect(() => parseDescriptor(JSON.stringify(bad))).toThrow(
      /version must be 1/,
    );
  });

  it('rejects missing transport', () => {
    const bad: Record<string, unknown> = { ...SAMPLE };
    delete bad.transport;
    expect(() => parseDescriptor(JSON.stringify(bad))).toThrow(
      /"transport".*non-empty string/,
    );
  });

  it('rejects empty boot_id', () => {
    const bad = { ...SAMPLE, boot_id: '' };
    expect(() => parseDescriptor(JSON.stringify(bad))).toThrow(
      /"boot_id".*non-empty string/,
    );
  });

  it('rejects non-numeric daemon_pid', () => {
    const bad = { ...SAMPLE, daemon_pid: 'oops' };
    expect(() => parseDescriptor(JSON.stringify(bad))).toThrow(
      /"daemon_pid".*finite number/,
    );
  });

  it('rejects wrong protocol_version', () => {
    const bad = { ...SAMPLE, protocol_version: 2 };
    expect(() => parseDescriptor(JSON.stringify(bad))).toThrow(
      /"protocol_version" must be 1/,
    );
  });

  it('accepts tlsCertFingerprintSha256 = string', () => {
    const ok = { ...SAMPLE, tlsCertFingerprintSha256: 'a'.repeat(64) };
    expect(parseDescriptor(JSON.stringify(ok)).tlsCertFingerprintSha256).toBe(
      'a'.repeat(64),
    );
  });

  it('rejects non-null non-string tlsCertFingerprintSha256', () => {
    const bad = { ...SAMPLE, tlsCertFingerprintSha256: 12 };
    expect(() => parseDescriptor(JSON.stringify(bad))).toThrow(
      /tlsCertFingerprintSha256/,
    );
  });
});

// ---------------------------------------------------------------------------
// rewriteDescriptorAddress
// ---------------------------------------------------------------------------

describe('rewriteDescriptorAddress', () => {
  it('replaces address + listener_addr with the bridge endpoint', () => {
    const out = rewriteDescriptorAddress(SAMPLE, 'http://127.0.0.1:51234');
    expect(out.address).toBe('http://127.0.0.1:51234');
    expect(out.listener_addr).toBe('http://127.0.0.1:51234');
  });

  it('leaves transport/boot_id/daemon_pid/etc. untouched', () => {
    const out = rewriteDescriptorAddress(SAMPLE, 'http://127.0.0.1:51234');
    expect(out.transport).toBe(SAMPLE.transport);
    expect(out.boot_id).toBe(SAMPLE.boot_id);
    expect(out.daemon_pid).toBe(SAMPLE.daemon_pid);
    expect(out.supervisorAddress).toBe(SAMPLE.supervisorAddress);
    expect(out.bind_unix_ms).toBe(SAMPLE.bind_unix_ms);
    expect(out.protocol_version).toBe(SAMPLE.protocol_version);
    expect(out.version).toBe(SAMPLE.version);
  });

  it('rejects empty bridgeAddress', () => {
    expect(() => rewriteDescriptorAddress(SAMPLE, '')).toThrow(/non-empty/);
  });

  it('rejects the BRIDGE_PENDING sentinel (ship-gate guard)', () => {
    expect(() => rewriteDescriptorAddress(SAMPLE, BRIDGE_PENDING_SENTINEL))
      .toThrow(/sentinel/);
  });
});

// ---------------------------------------------------------------------------
// createDescriptorHandler
// ---------------------------------------------------------------------------

describe('createDescriptorHandler — request handling', () => {
  const BRIDGE = 'http://127.0.0.1:51234';

  function makeHandler(opts: {
    file?: string;
    readImpl?: (p: string) => Promise<string>;
  } = {}) {
    return createDescriptorHandler({
      descriptorPath: '/fake/listener-a.json',
      bridgeAddress: BRIDGE,
      readDescriptorFile:
        opts.readImpl ??
        (async () => (opts.file !== undefined ? opts.file : SAMPLE_JSON)),
    });
  }

  it('serves the rewritten descriptor at the spec URL with JSON content-type', async () => {
    const h = makeHandler();
    const res = await h(new Request(DESCRIPTOR_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const body = (await res.json()) as DescriptorV1;
    expect(body.address).toBe(BRIDGE);
    expect(body.listener_addr).toBe(BRIDGE);
    expect(body.boot_id).toBe(SAMPLE.boot_id);
    expect(body.transport).toBe(SAMPLE.transport);
  });

  it('HEAD returns 200 with no body but correct headers', async () => {
    const h = makeHandler();
    const res = await h(new Request(DESCRIPTOR_URL, { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const text = await res.text();
    expect(text).toBe('');
  });

  it('rejects non-GET/HEAD with 405 + Allow header', async () => {
    const h = makeHandler();
    const res = await h(new Request(DESCRIPTOR_URL, { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('returns 404 for unknown app:// path', async () => {
    const h = makeHandler();
    const res = await h(new Request('app://ccsm/something-else.json'));
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-app scheme', async () => {
    const h = makeHandler();
    const res = await h(new Request('http://ccsm/listener-descriptor.json'));
    expect(res.status).toBe(404);
  });

  it('returns 503 when descriptor file is missing (ENOENT)', async () => {
    const h = makeHandler({
      readImpl: async () => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    const res = await h(new Request(DESCRIPTOR_URL));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not yet available/);
  });

  it('returns 503 on other read errors', async () => {
    const h = makeHandler({
      readImpl: async () => {
        const err = new Error('disk on fire') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      },
    });
    const res = await h(new Request(DESCRIPTOR_URL));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/disk on fire/);
  });

  it('returns 500 when descriptor JSON is corrupt', async () => {
    const h = makeHandler({ file: '{broken' });
    const res = await h(new Request(DESCRIPTOR_URL));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/descriptor invalid/);
  });

  it('returns 500 when descriptor schema is wrong (version mismatch)', async () => {
    const bad = JSON.stringify({ ...SAMPLE, version: 999 });
    const h = makeHandler({ file: bad });
    const res = await h(new Request(DESCRIPTOR_URL));
    expect(res.status).toBe(500);
  });

  it('refuses construction with the BRIDGE_PENDING sentinel', () => {
    expect(() =>
      createDescriptorHandler({
        descriptorPath: '/fake',
        bridgeAddress: BRIDGE_PENDING_SENTINEL,
      }),
    ).toThrow(/sentinel/);
  });

  it('refuses construction with an empty bridgeAddress', () => {
    expect(() =>
      createDescriptorHandler({
        descriptorPath: '/fake',
        bridgeAddress: '',
      }),
    ).toThrow(/non-empty/);
  });

  it('reads from the real filesystem when no readImpl override is provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccsm-protocol-app-'));
    try {
      const file = join(dir, 'listener-a.json');
      await writeFile(file, SAMPLE_JSON, 'utf8');
      const h = createDescriptorHandler({
        descriptorPath: file,
        bridgeAddress: BRIDGE,
      });
      const res = await h(new Request(DESCRIPTOR_URL));
      expect(res.status).toBe(200);
      const body = (await res.json()) as DescriptorV1;
      expect(body.address).toBe(BRIDGE);
      expect(body.boot_id).toBe(SAMPLE.boot_id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Electron registration helpers (structural fakes)
// ---------------------------------------------------------------------------

describe('registerAppSchemeAsPrivileged', () => {
  it('registers the app scheme with secure/standard/fetch/cors privileges', () => {
    const calls: Array<unknown> = [];
    const fake: ElectronSchemeRegistrarLike = {
      registerSchemesAsPrivileged: (schemes) => {
        calls.push(schemes);
      },
    };
    registerAppSchemeAsPrivileged(fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      {
        scheme: APP_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
        },
      },
    ]);
  });
});

describe('registerProtocolApp', () => {
  function makeFakeProtocol(): {
    protocol: ElectronProtocolLike;
    handles: Array<{ scheme: string; handler: (req: Request) => Promise<Response> }>;
    unhandled: string[];
  } {
    const handles: Array<{
      scheme: string;
      handler: (req: Request) => Promise<Response>;
    }> = [];
    const unhandled: string[] = [];
    return {
      protocol: {
        handle: (scheme, handler) => {
          handles.push({ scheme, handler });
        },
        unhandle: (scheme) => {
          unhandled.push(scheme);
        },
      },
      handles,
      unhandled,
    };
  }

  it('calls protocol.handle("app", handler) with a working handler', async () => {
    const fake = makeFakeProtocol();
    const unregister = registerProtocolApp({
      protocol: fake.protocol,
      bridgeAddress: 'http://127.0.0.1:1',
      descriptorPath: '/fake',
      readDescriptorFile: async () => SAMPLE_JSON,
    });
    expect(fake.handles).toHaveLength(1);
    expect(fake.handles[0].scheme).toBe(APP_SCHEME);

    const res = await fake.handles[0].handler(new Request(DESCRIPTOR_URL));
    expect(res.status).toBe(200);

    unregister();
    expect(fake.unhandled).toEqual([APP_SCHEME]);
  });

  it('unregister is a no-op when protocol.unhandle is not provided (older Electron)', () => {
    const handles: unknown[] = [];
    const protocol: ElectronProtocolLike = {
      handle: (scheme, handler) => {
        handles.push({ scheme, handler });
      },
      // unhandle deliberately omitted
    };
    const unregister = registerProtocolApp({
      protocol,
      bridgeAddress: 'http://127.0.0.1:1',
      descriptorPath: '/fake',
      readDescriptorFile: async () => SAMPLE_JSON,
    });
    expect(() => unregister()).not.toThrow();
  });

  it('falls back to descriptorPath() when no descriptorPath is provided', () => {
    const fake = makeFakeProtocol();
    const reader = vi.fn(async (_p: string) => SAMPLE_JSON);
    registerProtocolApp({
      protocol: fake.protocol,
      bridgeAddress: 'http://127.0.0.1:1',
      readDescriptorFile: reader,
      platform: 'linux',
      env: {},
    });
    // Trigger a request to confirm the resolved path went through to the reader.
    return fake.handles[0]
      .handler(new Request(DESCRIPTOR_URL))
      .then(() => {
        expect(reader).toHaveBeenCalledWith('/var/lib/ccsm/listener-a.json');
      });
  });
});

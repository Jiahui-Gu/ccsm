// T14 control-socket transport tests.
//
// Strategy: drive the real `net.createServer`-based transport over a
// per-test temp directory. We force `platform: 'linux'` for the path
// shape assertions so a Windows host CI run still exercises the POSIX
// branches; the actual on-disk listener uses the Node default (Unix
// socket node on POSIX, named pipe on Win32 — Node hides the difference
// for us when given a `\\.\pipe\...` address).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import {
  createControlSocketServer,
  defaultControlSocketPath,
  MAX_ACCEPT_PER_SEC,
  type ControlSocketServer,
} from '../control-socket.js';

const isWin = process.platform === 'win32';

let scratch: string;
let started: ControlSocketServer[] = [];
let opened: Socket[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ccsm-control-socket-'));
  started = [];
  opened = [];
});

afterEach(async () => {
  for (const c of opened) {
    try {
      c.destroy();
    } catch {
      // ignore
    }
  }
  for (const s of started) {
    try {
      await s.close();
    } catch {
      // ignore
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Win32 named pipes don't tolerate per-test reuse (they live in a single
 *  global namespace), so randomise the path in every test that drives a
 *  real listener on Windows. POSIX uses the scratch dir. */
function uniqueAddress(): string {
  if (isWin) {
    return `\\\\.\\pipe\\ccsm-control-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return join(scratch, 'ccsm-control.sock');
}

function connectAndWait(address: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const c = createConnection(address);
    opened.push(c);
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
}

describe('defaultControlSocketPath', () => {
  it('resolves POSIX path under runtimeRoot', () => {
    const p = defaultControlSocketPath('linux', '/run/user/1000/ccsm');
    expect(p).toBe('/run/user/1000/ccsm/ccsm-control.sock');
  });

  it('resolves macOS path under runtimeRoot', () => {
    const p = defaultControlSocketPath('darwin', '/Users/x/Library/Application Support/ccsm/run');
    expect(p).toBe('/Users/x/Library/Application Support/ccsm/run/ccsm-control.sock');
  });

  it('resolves Windows named-pipe with stable userhash prefix', () => {
    const p = defaultControlSocketPath('win32', 'C:\\ignored');
    // Shape: \\.\pipe\ccsm-control-<8 hex>
    expect(p.startsWith('\\\\.\\pipe\\ccsm-control-')).toBe(true);
    const tail = p.slice('\\\\.\\pipe\\ccsm-control-'.length);
    expect(tail).toMatch(/^[0-9a-f]{8}$/);
  });

  it('userhash is stable across calls (same user/host)', () => {
    const a = defaultControlSocketPath('win32', 'C:\\x');
    const b = defaultControlSocketPath('win32', 'C:\\x');
    expect(a).toBe(b);
  });
});

describe('createControlSocketServer — listen + accept', () => {
  it('starts and accepts a client connection (onConnection called with Duplex)', async () => {
    const address = uniqueAddress();
    const handed: Socket[] = [];
    let handResolve!: () => void;
    const handed1 = new Promise<void>((r) => { handResolve = r; });
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: (sock) => {
        handed.push(sock);
        handResolve();
      },
    });
    started.push(srv);

    await srv.listen();
    expect(srv.address).toBe(address);

    const client = await connectAndWait(address);
    await handed1;
    expect(handed.length).toBe(1);
    // The handed object must be a Duplex (Socket extends Duplex).
    expect(typeof handed[0]?.write).toBe('function');
    expect(typeof handed[0]?.on).toBe('function');

    client.destroy();
  });

  it('writes from server side reach the client (raw Duplex pass-through)', async () => {
    const address = uniqueAddress();
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: (sock) => {
        sock.write('PING\n');
      },
    });
    started.push(srv);
    await srv.listen();

    const client = await connectAndWait(address);
    const got = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      client.on('data', (c: Buffer) => {
        chunks.push(c);
        const s = Buffer.concat(chunks).toString('utf8');
        if (s.includes('\n')) resolve(s);
      });
    });
    expect(got).toBe('PING\n');
  });

  it('accepts multiple parallel connections', async () => {
    const address = uniqueAddress();
    let count = 0;
    const target = 4;
    let allResolve!: () => void;
    const allDone = new Promise<void>((r) => { allResolve = r; });
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {
        count += 1;
        if (count === target) allResolve();
      },
    });
    started.push(srv);
    await srv.listen();

    const clients = await Promise.all([
      connectAndWait(address),
      connectAndWait(address),
      connectAndWait(address),
      connectAndWait(address),
    ]);
    await allDone;
    expect(count).toBe(target);
    for (const c of clients) c.destroy();
  });
});

describe('createControlSocketServer — POSIX socket-node hygiene', () => {
  it.skipIf(isWin)('chmods the socket node to 0o600', async () => {
    const address = uniqueAddress();
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {},
    });
    started.push(srv);
    await srv.listen();

    const st = statSync(address);
    // Mask out type bits — only check perm bits.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)('cleans up the socket node on close()', async () => {
    const address = uniqueAddress();
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {},
    });
    await srv.listen();
    expect(() => statSync(address)).not.toThrow();
    await srv.close();
    expect(() => statSync(address)).toThrow();
  });

  it.skipIf(isWin)('pre-cleans a stale socket node from a prior crashed run', async () => {
    const address = uniqueAddress();
    // First boot — bind, then forcibly skip cleanup to simulate a crash.
    const srv1 = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {},
    });
    await srv1.listen();
    // Don't call close() — leak the inode.
    expect(() => statSync(address)).not.toThrow();

    // Second boot — must reuse the address without EADDRINUSE.
    const srv2 = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {},
    });
    started.push(srv2);
    await expect(srv2.listen()).resolves.toBeUndefined();

    // First server's underlying handle is now orphaned but the test will
    // tear scratch down in afterEach.
  });
});

describe('createControlSocketServer — close() drains', () => {
  it('close() resolves and refuses subsequent connections', async () => {
    const address = uniqueAddress();
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {},
    });
    await srv.listen();
    await srv.close();

    await expect(connectAndWait(address)).rejects.toBeTruthy();
  });

  it('close() is idempotent', async () => {
    const address = uniqueAddress();
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {},
    });
    await srv.listen();
    await srv.close();
    // Second close MUST not throw.
    await expect(srv.close()).resolves.toBeUndefined();
  });
});

describe('createControlSocketServer — pre-accept rate cap', () => {
  it('exports MAX_ACCEPT_PER_SEC = 50 (spec §3.4.1.a)', () => {
    expect(MAX_ACCEPT_PER_SEC).toBe(50);
  });

  it('drops connections beyond the cap within a single window', async () => {
    const address = uniqueAddress();
    let kept = 0;
    let destroyed = 0;
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      maxAcceptPerSec: 2,
      now: () => 1_000_000, // frozen clock — same window for every accept
      onConnection: (sock) => {
        kept += 1;
        sock.on('close', () => {
          // no-op
        });
      },
    });
    started.push(srv);
    await srv.listen();

    // Fire 5 connections in the same frozen-time window. Cap is 2 → 2 kept,
    // 3 destroyed pre-handler.
    const clients: Socket[] = [];
    for (let i = 0; i < 5; i += 1) {
      const c = createConnection(address);
      opened.push(c);
      clients.push(c);
      c.on('close', () => {
        destroyed += 1;
      });
    }

    // Wait for all to reach a terminal state (connected or closed).
    await new Promise((r) => setTimeout(r, 50));

    expect(kept).toBe(2);
    // 3 over the cap should have been destroyed by the server. The 2 kept
    // ones are still open, so destroyed count is 3 (plus they fire close
    // when the test cleans up — but at this assertion point only the
    // dropped sockets have closed).
    expect(destroyed).toBeGreaterThanOrEqual(3);
  });

  it('replenishes the bucket when the window rolls over', async () => {
    const address = uniqueAddress();
    let kept = 0;
    let nowMs = 1_000_000;
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      maxAcceptPerSec: 1,
      now: () => nowMs,
      onConnection: () => {
        kept += 1;
      },
    });
    started.push(srv);
    await srv.listen();

    // Window 1: cap 1, fire 2, only 1 kept.
    const c1 = await connectAndWait(address);
    const c2 = createConnection(address);
    opened.push(c2);
    await new Promise((r) => setTimeout(r, 30));
    expect(kept).toBe(1);

    // Roll the clock past RATE_WINDOW_MS = 1000 → bucket resets.
    nowMs += 2_000;
    const c3 = await connectAndWait(address);
    await new Promise((r) => setTimeout(r, 30));
    expect(kept).toBe(2);

    c1.destroy();
    c3.destroy();
  });
});

describe('createControlSocketServer — onConnection contract', () => {
  it('isolates a throwing onConnection (server keeps accepting)', async () => {
    const address = uniqueAddress();
    let calls = 0;
    let secondResolve!: () => void;
    const secondCall = new Promise<void>((r) => { secondResolve = r; });
    const srv = createControlSocketServer({
      runtimeRoot: scratch,
      socketPath: address,
      onConnection: () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        if (calls === 2) secondResolve();
      },
    });
    started.push(srv);
    await srv.listen();

    const c1 = createConnection(address);
    opened.push(c1);
    // Wait for the first accept to land + throw before opening c2.
    await new Promise((r) => setTimeout(r, 50));

    // Despite the throw, second connection must still be accepted.
    const c2 = await connectAndWait(address);
    await secondCall;
    expect(calls).toBe(2);
    c2.destroy();
  });
});

// Spec for the listener-A connection-descriptor atomic writer.
// Spec ref: ch03 §3.1 (atomic write tmp+fsync+rename) + §3.2 (v1 schema).
//
// We exercise four invariants the spec calls out by name:
//   1. write/read roundtrip — JSON parse echoes the payload byte-equivalent.
//   2. atomicity — `<path>.tmp` is gone after writeDescriptor resolves
//      (rename(2) succeeded, no orphan temp file).
//   3. boot_id present in the on-disk JSON (Electron's freshness witness).
//   4. version === 1 in the on-disk JSON (forever-stable schema marker).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DescriptorV1,
  descriptorTmpPath,
  removeDescriptor,
  writeDescriptor,
} from '../descriptor.js';

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

describe('writeDescriptor (atomic listener-a.json)', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccsm-descriptor-'));
    path = join(dir, 'listener-a.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('roundtrips: written bytes parse back to an equal payload', async () => {
    await writeDescriptor(path, SAMPLE);
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as DescriptorV1;
    expect(parsed).toEqual(SAMPLE);
  });

  it('is atomic: <path>.tmp is gone after a successful write', async () => {
    await writeDescriptor(path, SAMPLE);
    const tmp = descriptorTmpPath(path);
    await expect(stat(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('emits boot_id in the on-disk JSON (freshness witness)', async () => {
    await writeDescriptor(path, SAMPLE);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as DescriptorV1;
    expect(parsed.boot_id).toBe(SAMPLE.boot_id);
    expect(parsed.boot_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('emits version === 1 in the on-disk JSON (schema marker)', async () => {
    await writeDescriptor(path, SAMPLE);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      version: unknown;
      protocol_version: unknown;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.protocol_version).toBe(1);
  });

  it('refuses to clobber a stale .tmp left from a previous crashed boot', async () => {
    // Simulate a crashed prior boot: a .tmp file exists at the destination
    // tmp path. The wx open flag must surface this loudly rather than
    // silently merge / overwrite.
    const tmp = descriptorTmpPath(path);
    await writeFile(tmp, 'stale\n', 'utf8');
    await expect(writeDescriptor(path, SAMPLE)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('fsyncs the temp fd before rename (durability gate)', async () => {
    // Spec ch03 §3.1 step 2 mandates fsync(2) on the temp fd between write
    // and rename so the bytes are durable BEFORE the rename becomes visible.
    // We verify by patching FileHandle.prototype.sync (vitest can't spy on
    // the ESM namespace export, so prototype patching is the cheapest seam).
    // Removing `await fh.sync()` in descriptor.ts makes this assertion fail
    // (reverse-verify).
    const probeFh = await fsPromises.open(join(dir, '.probe'), 'w');
    const FileHandleProto = Object.getPrototypeOf(probeFh) as {
      sync: (this: unknown) => Promise<void>;
    };
    await probeFh.close();

    const syncCalls: string[] = [];
    const originalSync = FileHandleProto.sync;
    FileHandleProto.sync = async function patchedSync(this: unknown) {
      syncCalls.push('sync');
      return originalSync.call(this);
    };
    try {
      await writeDescriptor(path, SAMPLE);
      expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      FileHandleProto.sync = originalSync;
    }
  });
});

describe('removeDescriptor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccsm-descriptor-rm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is idempotent on a missing file (no throw)', async () => {
    await expect(removeDescriptor(join(dir, 'nope.json'))).resolves.toBeUndefined();
  });

  it('removes an existing descriptor file', async () => {
    const path = join(dir, 'listener-a.json');
    await writeDescriptor(path, SAMPLE);
    await removeDescriptor(path);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// packages/daemon/src/rpc/crash/__tests__/get-raw-crash-log.spec.ts
//
// Unit coverage for the SRP-decomposed pieces of the
// CrashService.GetRawCrashLog handler (Wave-3 Task #334).
//
// What this file pins (handler header doc §SRP layering):
//   1. Producer `streamRawCrashChunks` chunks bytes at the configured
//      cap and yields the file in order.
//   2. Producer treats ENOENT as "zero chunks then complete" (NOT an
//      error), per crash.proto comment + ch09 §2.
//   3. Producer respects an `AbortSignal` — pre-aborted signal → zero
//      chunks then complete (no read).
//   4. The 64 KiB constant matches the spec-pinned wire cap.
//
// The Connect-handler-shaped sink (`makeGetRawCrashLogHandler`) is
// covered end-to-end by the daemon-boot-e2e spec
// (`test/integration/daemon-boot-end-to-end.spec.ts` — Task #334's
// "GetRawCrashLog does NOT return Unimplemented" assertion). Mocking
// a Connect HandlerContext + `PRINCIPAL_KEY` here would duplicate that
// integration without adding signal — the wire shape (proto chunks,
// terminal sentinel, ConnectError on read failure) is the contract,
// not the in-process generator yields.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RAW_CHUNK_MAX_BYTES,
  streamRawCrashChunks,
} from '../get-raw-crash-log.js';

describe('streamRawCrashChunks (Task #334 — producer)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'ccsm-raw-crash-stream-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  });

  it('exposes the spec-pinned 64 KiB chunk cap', () => {
    // Forever-stable per crash.proto:77-78. If the spec amends the cap
    // a future PR updates this assertion explicitly (review-gate, not
    // auto-passing).
    expect(RAW_CHUNK_MAX_BYTES).toBe(64 * 1024);
  });

  it('yields zero chunks then completes when the file does not exist', async () => {
    // Spec ch09 §2 + crash.proto comment: "If the file does not exist
    // (no fatal-via-NDJSON crashes have occurred), daemon completes the
    // stream after sending zero chunks."
    const path = join(tmpRoot, 'nonexistent.ndjson');
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamRawCrashChunks({ path })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it('yields a single chunk for a file smaller than the chunk cap', async () => {
    const path = join(tmpRoot, 'small.ndjson');
    const payload = '{"id":"a","ts_ms":1,"source":"x","summary":"y","detail":"","labels":{},"owner_id":"daemon-self"}\n';
    await writeFile(path, payload, 'utf8');
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamRawCrashChunks({ path })) {
      chunks.push(chunk);
    }
    // Concatenate and verify byte-identical round-trip.
    const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(total.toString('utf8')).toBe(payload);
  });

  it('splits a file larger than the chunk cap into multiple chunks', async () => {
    // Use a small chunk size so we can stage a tiny fixture file but
    // still exercise the multi-chunk path. 1 KiB chunks * 5 KiB file
    // = at least 5 chunks. Each non-final chunk MUST be <= chunkSize.
    const chunkSize = 1024;
    const totalBytes = 5 * 1024;
    const path = join(tmpRoot, 'large.ndjson');
    const payload = Buffer.alloc(totalBytes, 'A');
    await writeFile(path, payload);
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamRawCrashChunks({ path, chunkSize })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(chunkSize);
    }
    const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(total.byteLength).toBe(totalBytes);
    expect(total.equals(payload)).toBe(true);
  });

  it('aborts cleanly when the AbortSignal is already aborted at start', async () => {
    // Spec posture mirror of `subscribeAsAsyncIterable` (sessions/
    // watch-sessions.ts): an already-aborted signal at construction
    // time terminates the stream without any reads. The Node read
    // stream raises an `AbortError` which the producer surfaces as a
    // throw — the sink maps it to `crash.raw_log_read_failed` (or, in
    // Connect's lifecycle, the abort already terminated the RPC). For
    // the producer's contract here, we only assert the iterator does
    // not block forever and yields zero chunks before terminating
    // (either via abort throw or via `done`).
    const path = join(tmpRoot, 'will-not-read.ndjson');
    await writeFile(path, Buffer.alloc(8 * 1024, 'B'));
    const controller = new AbortController();
    controller.abort();
    const chunks: Uint8Array[] = [];
    let threw = false;
    try {
      for await (const chunk of streamRawCrashChunks({
        path,
        signal: controller.signal,
      })) {
        chunks.push(chunk);
      }
    } catch {
      threw = true;
    }
    expect(chunks).toEqual([]);
    // Either path is acceptable; what's NOT acceptable is yielding
    // bytes despite the abort (would mean we kept reading).
    expect(chunks.length === 0 && (threw || true)).toBe(true);
  });
});

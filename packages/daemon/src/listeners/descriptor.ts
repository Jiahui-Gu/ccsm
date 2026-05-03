// Listener-A connection descriptor — atomic writer + v1 schema.
//
// Spec ch03 §3.1 (atomic write discipline: tmp + fsync + rename) and
// §3.2 (descriptor v1 schema, forever-stable). The daemon writes this
// JSON file exactly once per boot at a per-OS path so Electron can
// rendezvous with the bound Listener A and verify freshness via the
// embedded `boot_id` (ch03 §3.3 handshake).
//
// Scope (T1.6):
//   - DescriptorV1 type + payload shape (transport / address / boot_id / etc.)
//   - writeDescriptor(path, payload) — write JSON to `<path>.tmp`, fsync the
//     fd, then rename(2) over `<path>`. Rename is atomic on every supported
//     FS, so Electron never observes a torn file.
//   - removeDescriptor(path) — best-effort unlink (used by tests / shutdown
//     paths that explicitly want the file gone; spec ch03 §3.1 step 5 says
//     orphan files between boots are NORMAL, so daemon graceful shutdown
//     does NOT call this).
//
// Out of scope (deliberately deferred):
//   - JSON Schema validator file → Task #125 (T10.4).
//   - makeListenerA factory + listener slot wiring → T1.4.
//   - Per-OS state-dir paths → Task #57 (T5.3); this module accepts an
//     absolute path argument and is path-agnostic.

import { open as fsOpen, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/**
 * Closed enum of supported transports. Stringified identically into the
 * descriptor's `transport` field. Spec ch03 §1a — additions in v0.4 ship
 * under a NEW descriptor file, never as new values in this enum.
 */
export type DescriptorTransport =
  | 'KIND_UDS'
  | 'KIND_NAMED_PIPE'
  | 'KIND_TCP_LOOPBACK_H2C'
  | 'KIND_TCP_LOOPBACK_H2_TLS';

/**
 * v1 descriptor payload. Forever-stable — v0.4+ additions go in NEW
 * top-level optional fields, never as enum widenings or type changes
 * (spec ch03 §3.2 + ch15 §3 forbidden-pattern 8).
 *
 * Field semantics (verbatim from spec ch03 §3.2):
 *   - version            literal `1` (bumps only on wire-incompatible breaks)
 *   - transport          closed enum from §1a
 *   - address            bind address; format depends on transport
 *   - tlsCertFingerprintSha256
 *                        SHA-256 of the listener's self-signed cert when
 *                        transport === 'KIND_TCP_LOOPBACK_H2_TLS'; null
 *                        otherwise
 *   - supervisorAddress  Supervisor UDS / named-pipe path (UDS-only — spec §7)
 *   - boot_id            per-boot UUIDv4 (freshness witness; ch02 §3 step 5)
 *   - daemon_pid         observability only — Electron MUST NOT auth on this
 *   - listener_addr      duplicate of `address` for grep-friendly logs
 *   - protocol_version   `1` for v0.3; bumps only on wire-incompatible change
 *   - bind_unix_ms       daemon process start time, observability only
 *
 * NOTE on field naming: snake_case matches the spec table verbatim and the
 * proto wire convention from ch04. Keep both spellings together so the
 * reverse-grep from `listener-a.json` to this type stays one hop.
 */
export interface DescriptorV1 {
  readonly version: 1;
  readonly transport: DescriptorTransport;
  readonly address: string;
  readonly tlsCertFingerprintSha256: string | null;
  readonly supervisorAddress: string;
  readonly boot_id: string;
  readonly daemon_pid: number;
  readonly listener_addr: string;
  readonly protocol_version: 1;
  readonly bind_unix_ms: number;
}

/** Suffix used for the in-flight temp file. Kept in the same directory as
 * the destination so `rename(2)` stays within one filesystem (atomic). */
export const DESCRIPTOR_TMP_SUFFIX = '.tmp';

/** Compute the temp-file path used by `writeDescriptor`. Exposed so tests
 * can assert the temp file is gone after a successful write. */
export function descriptorTmpPath(finalPath: string): string {
  // Same directory as final path so rename(2) is intra-FS (atomic). Adding
  // the suffix to the basename (rather than the dir) keeps the temp file
  // co-located with the descriptor for ops grep (`ls listener-a*`).
  return join(dirname(finalPath), `${basename(finalPath)}${DESCRIPTOR_TMP_SUFFIX}`);
}

/**
 * Write the descriptor atomically. Spec ch03 §3.1 sequence:
 *   1. write JSON to `<path>.tmp` in the same directory;
 *   2. fsync(2) the temp fd (so the bytes are durable BEFORE the rename
 *      becomes visible — otherwise a crash between rename and fsync could
 *      leave a zero-byte descriptor that survives reboot);
 *   3. rename(2) `<path>.tmp` -> `<path>` (atomic on every supported FS,
 *      including NTFS via MoveFileExW(MOVEFILE_REPLACE_EXISTING) which is
 *      what libuv's uv_fs_rename uses on Windows).
 *
 * Throws on any I/O failure; caller is responsible for logging + lifecycle
 * fail() (spec ch02 §3 — descriptor write is part of phase STARTING_LISTENERS,
 * so a failure here aborts boot before /healthz can flip to 200).
 */
export async function writeDescriptor(
  path: string,
  payload: DescriptorV1,
): Promise<void> {
  const tmpPath = descriptorTmpPath(path);
  // Pretty-print with a trailing newline — `cat listener-a.json` from an
  // operator shell is the primary debugging tool; the 2-space indent is
  // wire-stable irrelevant (Electron's JSON.parse ignores whitespace).
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  // `wx` = O_WRONLY|O_CREAT|O_EXCL — fail if a stale temp file exists.
  // A leftover .tmp from a prior crashed boot is suspect; refusing to
  // overwrite makes the failure mode loud rather than silently producing
  // a possibly-merged descriptor.
  const fh = await fsOpen(tmpPath, 'wx', 0o644);
  try {
    await fh.writeFile(json, 'utf8');
    // fsync the fd, NOT the directory. Per spec §3.1 we need the bytes on
    // disk BEFORE the rename becomes visible; fsync on the fd forces the
    // file's data + metadata. Directory-level fsync (for the rename itself)
    // is a future hardening item not required by the spec for v0.3.
    await fh.sync();
  } finally {
    await fh.close();
  }

  // rename(2) is atomic across same-FS. If this throws, the .tmp file is
  // left behind for forensic inspection — caller decides whether to
  // unlink it (we do NOT here, because losing the tmp on a flaky FS
  // would erase the only diagnostic).
  await rename(tmpPath, path);
}

/**
 * Remove the descriptor file. Best-effort: missing-file is NOT an error
 * (idempotent for test cleanup paths). Any other I/O error is rethrown.
 *
 * Spec ch03 §3.1 step 5: the daemon does NOT call this on graceful
 * shutdown — orphan descriptor files between boots are normal and the
 * boot_id mismatch check handles them. This export exists for tests
 * and for the rare admin-tool teardown path.
 */
export async function removeDescriptor(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

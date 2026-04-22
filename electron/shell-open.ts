import * as path from 'path';
import { promises as fsp } from 'fs';

/**
 * Result of an `openPath` IPC call. Mirrors the discriminated-union shape
 * the rest of the codebase uses (memory:*, pr:*, etc.) so the renderer
 * can branch on `ok` without sniffing strings.
 */
export type OpenPathResult =
  | { ok: true }
  | { ok: false; error: 'invalid_path' | 'not_found' | 'open_failed'; detail?: string };

/**
 * Minimal slice of Electron's `shell` we depend on. Declared so unit tests
 * can pass a stub without dragging the real `electron` runtime in.
 *
 * `shell.openPath` returns an empty string on success and an error message
 * on failure (Electron's quirk — not a thrown error).
 */
export interface ShellLike {
  openPath(p: string): Promise<string>;
}

/**
 * Pure, testable core of the `shell:openPath` IPC handler.
 *
 * Security boundary:
 *   - Reject any non-string / empty input.
 *   - Reject relative paths — we never want to resolve against the main
 *     process's cwd, which is undefined from the renderer's POV.
 *   - Reject paths that don't exist on disk. `shell.openPath` would
 *     otherwise silently no-op or open the OS's "file not found" dialog,
 *     both of which are worse than a structured error.
 *
 * On success the OS file manager opens with the target revealed
 * (Explorer / Finder / GNOME Files / etc.).
 */
export async function openPathSafe(
  rawPath: unknown,
  shell: ShellLike,
  fs: { access: (p: string) => Promise<void> } = { access: fsp.access }
): Promise<OpenPathResult> {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || !path.isAbsolute(rawPath)) {
    return { ok: false, error: 'invalid_path' };
  }
  try {
    await fs.access(rawPath);
  } catch {
    return { ok: false, error: 'not_found' };
  }
  const err = await shell.openPath(rawPath);
  if (err) return { ok: false, error: 'open_failed', detail: err };
  return { ok: true };
}

/**
 * Pure decision functions for session-title bridge.
 *
 * Extracted from `index.ts` per #677 SRP cleanup. These are decider-only:
 * given inputs, return a classification or boolean. No I/O, no SDK calls,
 * no mutation. Sinks (op-chain map, pending-rename map, TTL cache) and
 * the SDK loader (producer) stay in `index.ts`.
 */

/**
 * Classify an SDK error as either "JSONL not yet written" or "SDK threw".
 *
 * | err shape                          | result                        |
 * | ---------------------------------- | ----------------------------- |
 * | object with `code === 'ENOENT'`    | { reason: 'no_jsonl' }        |
 * | Error                              | { reason: 'sdk_threw', message: err.message } |
 * | string                             | { reason: 'sdk_threw', message: err } |
 * | anything else                      | { reason: 'sdk_threw' }       |
 *
 * Node fs errors carry `.code`; the SDK re-throws them verbatim (or wraps
 * with a matching `.code`). Anything ENOENT-shaped is the "session file does
 * not exist yet" signal — common right after `query()` starts before the
 * first message has flushed JSONL.
 */
export function classifyError(
  err: unknown
): { reason: 'no_jsonl' | 'sdk_threw'; message?: string } {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === 'ENOENT') return { reason: 'no_jsonl' };
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : undefined;
  return { reason: 'sdk_threw', message };
}

/**
 * Decide whether to retry `renameSession` without an explicit `dir` arg.
 *
 * The Sidebar rename hands us `session.cwd`. SDK derives the on-disk
 * project-key directory from that cwd via realpath; when the cwd was
 * renamed/moved/case-shifted since the session was created (common on
 * Windows), the encoded key does not match the directory the JSONL actually
 * lives under, and SDK throws "Session <sid> not found in project directory
 * for <dir>". The dir-less SDK path scans every `~/.claude/projects/*`
 * subdir and appends to the one that owns `<sid>.jsonl`, so retrying without
 * `dir` is the bulletproof recovery.
 *
 * Returns true only when a `dir` was supplied (otherwise nothing to retry
 * away from) AND the SDK error message matches the project-mismatch shape.
 */
export function decideRetry(err: unknown, dir: string | undefined): boolean {
  if (dir === undefined) return false;
  const cls = classifyError(err);
  return (
    cls.reason === 'sdk_threw' &&
    typeof cls.message === 'string' &&
    cls.message.includes('not found in project directory')
  );
}

/**
 * Decide whether a failed rename should be re-queued for the next flush
 * attempt. Used by `flushPendingRename` after a pending replay: if the JSONL
 * still does not exist on disk, the watcher will fire again on the next
 * frame and we want the same pending entry to be retried.
 *
 * Returns true iff `result` is a `RenameResult`-shaped failure with reason
 * `'no_jsonl'`. Anything else (success, sdk_threw, malformed) → false.
 */
export function decideRequeue(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { ok?: unknown; reason?: unknown };
  if (r.ok !== false) return false;
  return r.reason === 'no_jsonl';
}

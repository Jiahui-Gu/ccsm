/**
 * Partial-accept filter for Edit / Write / MultiEdit tool calls (#251).
 *
 * The renderer can offer the user per-hunk Allow / Reject in the permission
 * prompt. When only a subset is accepted, we don't pass the full original
 * input back to claude.exe — instead we hand it an `updatedInput` containing
 * just the accepted hunks, using the `updatedInput` channel that the
 * `can_use_tool` control_response already supports.
 *
 * Hunk indices map directly to `DiffSpec.hunks` ordering produced by
 * `src/utils/diff.ts`:
 *   - Edit:      always 1 hunk (index 0).
 *   - Write:     always 1 hunk (index 0).
 *   - MultiEdit: one hunk per entry in `edits`, in array order.
 *
 * Behaviour:
 *   - All hunks accepted (or `acceptedHunks === undefined`) -> return the
 *     original input unchanged. Callers should treat this as "no rewrite".
 *   - Empty `acceptedHunks` -> returns null. The caller MUST translate that
 *     into a reject decision; an empty Edit/Write would otherwise corrupt
 *     the file or no-op silently.
 *   - Subset accepted on MultiEdit -> returns a new input with `edits`
 *     filtered to the chosen indices in their original order.
 *   - Subset accepted on Edit/Write -> only meaningful values are 0/all or
 *     none; we treat "the only hunk accepted" as full-allow and "0 hunks"
 *     as null (reject). Per-line slicing inside the single hunk is out of
 *     scope for this PR — see the UI follow-up.
 *
 * Returns:
 *   - The (possibly rewritten) tool input object suitable for
 *     `CanUseToolDecision.updatedInput`.
 *   - `null` when the partial selection means "deny entirely".
 *   - The original input untouched when no filtering is needed (caller
 *     should pass `updatedInput: undefined` in that case).
 */

export type PartialFilterResult =
  | { kind: 'unchanged' }
  | { kind: 'updated'; updatedInput: Record<string, unknown> }
  | { kind: 'reject' };

export function filterToolInputByAcceptedHunks(
  toolName: string,
  input: unknown,
  acceptedHunks: number[] | undefined
): PartialFilterResult {
  // No selection provided -> caller wants the legacy whole-tool allow.
  if (acceptedHunks === undefined) return { kind: 'unchanged' };

  // Defensive: only objects can be filtered. Anything else falls through
  // unchanged (Bash etc. should never go through this code path, but if a
  // caller mis-routes we fail-open to "no rewrite" rather than crash).
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'unchanged' };
  }

  // Normalize + dedupe accepted indices.
  const accepted = Array.from(new Set(acceptedHunks)).sort((a, b) => a - b);

  switch (toolName) {
    case 'Edit':
    case 'Write': {
      // Single-hunk tools: empty selection -> reject; otherwise unchanged.
      // (Index value irrelevant — there's only hunk 0.)
      if (accepted.length === 0) return { kind: 'reject' };
      return { kind: 'unchanged' };
    }
    case 'MultiEdit': {
      const o = input as Record<string, unknown>;
      const edits = Array.isArray(o.edits) ? o.edits : [];
      if (edits.length === 0) return { kind: 'unchanged' };
      const filtered = accepted
        .filter((i) => Number.isInteger(i) && i >= 0 && i < edits.length)
        .map((i) => edits[i]);
      if (filtered.length === 0) return { kind: 'reject' };
      if (filtered.length === edits.length) return { kind: 'unchanged' };
      return {
        kind: 'updated',
        updatedInput: { ...o, edits: filtered },
      };
    }
    default:
      return { kind: 'unchanged' };
  }
}

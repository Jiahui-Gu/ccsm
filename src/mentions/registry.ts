// @file mention registry.
//
// Mirrors the shape of `src/slash-commands/registry.ts` so InputBar can
// drive both pickers from one trigger-detection / fuzzy-match playbook.
// Trigger pattern matches the upstream Anthropic Claude Code VS Code
// extension (webview index.js): `/(?:^|\s)@[^\s]*/gm`. The picker only
// shows files (no @symbol — upstream's only @mention surface is the
// `mention-file` command, no symbol picker exists).

import Fuse from 'fuse.js';
import type { WorkspaceFile } from '../shared/ipc-types';

export type AtTriggerState =
  | { active: false }
  | {
      active: true;
      // Substring after `@` and before the caret. Empty string means the
      // user just typed `@` and hasn't typed any filter yet.
      query: string;
      // Inclusive start index of `@` in `value`. Used by the commit path
      // to splice the chosen mention back into the textarea.
      atStart: number;
      // Exclusive end of the in-progress mention token (where the caret is).
      // Always equals `caret` for a live trigger.
      tokenEnd: number;
    };

// Detect whether the caret is inside a mention token of the form `@xxx`.
// Mirrors upstream's `(?:^|\s)@[^\s]*` regex but evaluated against the
// substring immediately preceding the caret (no need to scan forward).
//
// Rules:
//   - `@` must be at the very start of `value` OR preceded by whitespace.
//     (Stops `email@domain` from accidentally opening the picker.)
//   - Everything between `@` and the caret must be non-whitespace; the
//     first whitespace closes the trigger.
//   - Trigger covers a single token only; multi-line composers are fine
//     because the no-whitespace rule includes `\n`.
export function detectAtTrigger(value: string, caret: number): AtTriggerState {
  if (caret <= 0 || caret > value.length) return { active: false };
  // Walk backwards from the caret looking for `@` with whitespace (or BOS)
  // immediately before it. Bail as soon as we hit whitespace — that means
  // we're past the end of any candidate mention token.
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === '@') {
      const prev = i === 0 ? '' : value[i - 1];
      if (i === 0 || /\s/.test(prev)) {
        return {
          active: true,
          query: value.slice(i + 1, caret),
          atStart: i,
          tokenEnd: caret,
        };
      }
      return { active: false };
    }
    if (/\s/.test(ch)) return { active: false };
    i--;
  }
  return { active: false };
}

// Pure filter used by the picker + tests. Same Fuse settings shape as the
// slash-command picker (threshold 0.4, name weight 3) so the muscle-memory
// feel stays consistent across both pickers.
//
// Empty query: return the first 50 entries unchanged. We don't need to show
// 5000 files at once — 50 is enough screen for the user to confirm "yep,
// the picker is open" before they start typing to filter. The cap also
// keeps the listbox DOM small.
const EMPTY_QUERY_LIMIT = 50;

export function filterMentionFiles(all: WorkspaceFile[], query: string): WorkspaceFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, EMPTY_QUERY_LIMIT);

  // Pin exact basename + prefix matches first, in input order.
  const pinned: WorkspaceFile[] = [];
  const pinnedSet = new Set<WorkspaceFile>();
  for (const f of all) {
    if (f.name.toLowerCase() === q) {
      pinned.push(f);
      pinnedSet.add(f);
    }
  }
  for (const f of all) {
    if (pinnedSet.has(f)) continue;
    if (f.name.toLowerCase().startsWith(q)) {
      pinned.push(f);
      pinnedSet.add(f);
    }
  }

  const remainder = all.filter((f) => !pinnedSet.has(f));
  const fuse = new Fuse(remainder, {
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    keys: [
      { name: 'name', weight: 3 },
      { name: 'path', weight: 1 },
    ],
  });
  const fuzzy = fuse.search(q).map((r) => r.item);

  // Cap final results so a wildcard-ish query doesn't render thousands of rows.
  return [...pinned, ...fuzzy].slice(0, 100);
}

// Splice `@<path>` into `value`, replacing the in-progress mention token.
// Always trails with a single space so the user can keep typing without
// having to insert one themselves (matches upstream behavior — see
// `insertAtMention` in webview/index.js, which appends ` ` for the
// non-bare case).
export function commitMention(
  value: string,
  trigger: { atStart: number; tokenEnd: number },
  filePath: string
): { next: string; caret: number } {
  const before = value.slice(0, trigger.atStart);
  const after = value.slice(trigger.tokenEnd);
  // If the user already left a space after the caret, don't double up.
  const tail = after.startsWith(' ') ? '' : ' ';
  const next = `${before}@${filePath}${tail}${after}`;
  const caret = (before + '@' + filePath + tail).length;
  return { next, caret };
}

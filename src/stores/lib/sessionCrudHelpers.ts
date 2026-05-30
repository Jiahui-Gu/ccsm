import type { Group } from '../../types';
import { defaultGroupName } from '../slices/groupsSlice';

// Shared wrapper for the three writeback-failure branches in `renameSession`
// (no_jsonl, sdk_threw, ipc-catch). All three need to push the manual rename
// into the main-process pending queue so the flusher retries later — and all
// three need to swallow + log any IPC error so a failed enqueue doesn't crash
// the renderer mid-rename. Inlined helper (not its own module) because it
// only has one caller and reads `bridge` from the local closure shape.
export type RenameBridge = {
  enqueuePending: (sid: string, title: string, dir?: string) => Promise<void>;
};
export async function tryEnqueuePending(
  bridge: RenameBridge,
  id: string,
  name: string,
  dir: string | undefined
): Promise<void> {
  try {
    await bridge.enqueuePending(id, name, dir);
  } catch (enqErr) {
    console.error(`[rename:writeback-failed] enqueue sid=${id}`, enqErr);
  }
}

export function nextId(prefix: string): string {
  // Prefer crypto.randomUUID — collision-resistant across rapid in-tick
  // creation. Keep the `prefix-` shape so existing logs / DOM ids stay
  // parseable.
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } })
      : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return `${prefix}-${g.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mint a session id using the same raw UUID format the Claude Code CLI uses
 * for its `~/.claude/projects/<project>/<sid>.jsonl` filenames. ccsm passes
 * this id to the SDK's `sessionId` option at spawn time, so the JSONL
 * transcript file name is identical to the in-app session id.
 */
export function newSessionId(): string {
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } })
      : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // Fallback — synthesize a v4-shaped UUID for envs where crypto is shimmed
  // away (Node < 14.17 / locked-down sandbox / jsdom).
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const y = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${y}${hex(3)}-${hex(12)}`;
}

function firstUsableGroupId(groups: Group[]): string | null {
  const g = groups.find((x) => x.kind === 'normal');
  return g ? g.id : null;
}

/**
 * Resolve "where should the next session go?" — return either an existing
 * usable (`kind === 'normal'`) group, or synthesize a fresh one with the
 * current language's default name.
 */
export function ensureUsableGroup(
  groups: Group[],
  preferredId?: string | null
): { groups: Group[]; groupId: string } {
  const isUsable = (gid: string | null | undefined): boolean => {
    if (!gid) return false;
    const g = groups.find((x) => x.id === gid);
    return !!g && g.kind === 'normal';
  };
  if (preferredId && isUsable(preferredId)) {
    return { groups, groupId: preferredId };
  }
  const fallback = firstUsableGroupId(groups);
  if (fallback) return { groups, groupId: fallback };
  const synth: Group = {
    id: nextId('g'),
    name: defaultGroupName(),
    nameKey: 'sidebar.defaultGroupName',
    collapsed: false,
    kind: 'normal',
  };
  return { groups: [synth, ...groups], groupId: synth.id };
}

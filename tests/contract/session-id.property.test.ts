// Property test for session-id / state-key generators (audit finding 9).
//
// ccsm mints two kinds of ids the store relies on for uniqueness:
//
//   1. Session ids — produced by the private `newSessionId()` in
//      `src/stores/slices/sessionCrudSlice.ts`. Used as both the in-app
//      session row id AND the CLI JSONL filename (so the renderer's id
//      is identical to the SDK `sessionId` option passed at spawn). A
//      collision would land two sessions writing to the same JSONL file
//      and break the watcher's per-sid title tracking.
//
//   2. Group ids — produced by the private `nextId('g')` helper inside
//      `ensureUsableGroup()` when no usable group exists for a newly
//      created session. Format: `g-<uuid>`.
//
// Both generators are file-private. We exercise them through the public
// store API (`createSession`) which is the only way they're observable
// from outside the module — the same surface every renderer caller
// touches. Driving the public API also catches the case where a future
// refactor swaps the generator for one with weaker guarantees without
// updating the property test (which would still hold for the unit
// generator but fail for the store-observable shape).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionCrudSlice } from '../../src/stores/slices/sessionCrudSlice';
import { createGroupsSlice } from '../../src/stores/slices/groupsSlice';
import type { RootStore } from '../../src/stores/slices/types';
import type { Group } from '../../src/types';

// Same harness shape as tests/stores/slices/sessionCrudSlice.test.ts —
// kept inline so this contract file has no cross-test dependency.
function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = { ...initial };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore),
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const sessions = createSessionCrudSlice(set, get);
  const groups = createGroupsSlice(set, get);
  state = { ...state, ...sessions, ...groups, ...initial };
  return { state: () => state, sessions, set, get };
}

// `createSession` peeks at `window.ccsm?.userCwds?.push(...)` when the
// cwd diverges from userHome. Stub it out so the test doesn't trip on
// the missing preload bridge.
beforeEach(() => {
  (window as unknown as { ccsm?: unknown }).ccsm = undefined;
});
afterEach(() => {
  (window as unknown as { ccsm?: unknown }).ccsm = undefined;
});

// ── Shape invariants ───────────────────────────────────────────────────
// The session-id generator prefers `crypto.randomUUID()` (RFC4122 v4
// shape) and falls back to a hand-synthesized v4-shaped string in
// environments without crypto. Both produce the same canonical 36-char
// `8-4-4-4-12` hex+dash layout — the JSONL filename layer downstream
// depends on it.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Group ids minted by `nextId('g')` are either `g-<uuid>` (crypto path)
// or `g-<base36-time>-<base36-rand>` (fallback path). Both fit this
// looser shape.
const GROUP_ID_RE = /^g-[A-Za-z0-9-]+$/;

const N = 10_000;

describe('session/group id generators (audit finding 9)', () => {
  it('session ids are unique over 10k samples', () => {
    const ids = new Set<string>();
    const h = harness({ groups: [{ id: 'g-default', name: 'd', collapsed: false, kind: 'normal' }] });
    for (let i = 0; i < N; i++) {
      h.sessions.createSession('/tmp');
      const sid = h.state().activeId;
      expect(sid).toBeTruthy();
      expect(ids.has(sid)).toBe(false);
      ids.add(sid);
    }
    expect(ids.size).toBe(N);
  });

  it('session ids match the canonical UUID-v4 shape', () => {
    const h = harness({ groups: [{ id: 'g-default', name: 'd', collapsed: false, kind: 'normal' }] });
    // Sample a smaller N for shape — the shape regex is cheap but the
    // failure mode (one bad shape) doesn't need 10k repeats to surface.
    for (let i = 0; i < 500; i++) {
      h.sessions.createSession('/tmp');
      const sid = h.state().activeId;
      expect(sid).toMatch(UUID_V4_RE);
    }
  });

  it('synthesized group ids are unique over 10k samples', () => {
    const ids = new Set<string>();
    for (let i = 0; i < N; i++) {
      // Start with only an archive group → no usable normal group, so
      // createSession synthesizes a fresh one via `nextId('g')`.
      const archive: Group = { id: 'g-arch', name: 'A', collapsed: false, kind: 'archive' };
      const h = harness({ groups: [archive] });
      h.sessions.createSession('/tmp');
      const synth = h.state().groups.find((g) => g.kind === 'normal');
      expect(synth).toBeDefined();
      const gid = synth!.id;
      expect(gid).toMatch(GROUP_ID_RE);
      expect(ids.has(gid)).toBe(false);
      ids.add(gid);
    }
    expect(ids.size).toBe(N);
  });

  it('session ids never collide with group ids (disjoint namespaces)', () => {
    const sessionIds = new Set<string>();
    const groupIds = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const archive: Group = { id: 'g-arch', name: 'A', collapsed: false, kind: 'archive' };
      const h = harness({ groups: [archive] });
      h.sessions.createSession('/tmp');
      sessionIds.add(h.state().activeId);
      const synth = h.state().groups.find((g) => g.kind === 'normal');
      groupIds.add(synth!.id);
    }
    // Group ids carry the `g-` prefix; session ids are raw UUIDs. The
    // sets must be fully disjoint — anything else means the prefix
    // discipline regressed and a session id could be parsed as a group
    // id (or vice versa) elsewhere in the store.
    for (const sid of sessionIds) {
      expect(groupIds.has(sid)).toBe(false);
    }
  });
});

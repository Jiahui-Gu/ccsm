// Renderer-side polyfill that exposes
// `window.ccsmPty.checkClaudeAvailable` against the typed Connect
// `PtyService` client.
//
// Task #464 / SHIP-GATE — root cause of the "every user sees
// ClaudeMissingGuide on first paint" bug:
//   - `src/App.tsx:227` calls `window.ccsmPty.checkClaudeAvailable()`
//     in its boot effect to decide whether to mount the main UI or the
//     guide. The optional chain `bridge?.checkClaudeAvailable` was
//     resolving to `undefined` because v0.3 ships ZERO production
//     preload that installs `window.ccsmPty` (the only sanctioned
//     `contextBridge.exposeInMainWorld` call site,
//     `electron/ipc-allowlisted/preload-allowlisted.ts`, exposes
//     `window.ccsm` — note the missing `Pty` suffix — and the
//     `window.ccsmPty` surface is referenced ONLY in tests / harness
//     stubs).
//   - The catch branch in App.tsx then flipped `claudeAvailable` to
//     `false` and rendered the guide unconditionally.
//
// Why a renderer-side polyfill (and NOT a preload bridge):
//   - The v0.3 daemon-split architecture moved every previously-IPC
//     PtyService surface onto the loopback Connect-RPC transport. The
//     daemon resolves claude (it's the process that spawns ttyd /
//     pty-host, not Electron). Going renderer → preload → ipcMain →
//     daemon RPC would add two hops AND require a new IPC channel on
//     the §3.1 allowlist (which is closed-form and forbids new entries
//     without a chapter-15 audit row).
//   - The renderer ALREADY has a typed Connect `PtyService` client
//     once `<RendererBoot>` builds the clients bundle (see
//     `boot.tsx`'s `ColdStartGate`). The cheapest fix is to install
//     `window.ccsmPty.checkClaudeAvailable` as a thin async wrapper
//     around `clients.pty.checkClaudeAvailable(...)`. Same wire path
//     the rest of the v0.3 RPC surface uses; no new IPC; no preload
//     amendment.
//
// Why we DO NOT install other `window.ccsmPty.*` methods here:
//   - `list / spawn / attach / input / resize / kill / get /
//     onData / onExit / clipboard / getBufferSnapshot` are owned by
//     other tasks (Wave-3 / pty-host wire-up). Those entries land
//     additively when their RPC handlers ship. This file's scope is
//     ONE method — the SHIP-GATE first-paint probe — and one method
//     only.
//
// SRP layering:
//   - producer: the Connect `PtyService` client (`clients.pty`),
//                supplied by `<RendererBoot>`'s `ColdStartGate`.
//   - decider:  none — this is a thin sink.
//   - sink:     `installWindowCcsmPtyBridge(clients)` — performs the
//                one-time `Object.defineProperty` (defensive: don't
//                blow away existing test stubs of `window.ccsmPty`).
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. There is no existing renderer-side helper that bridges Connect
//      clients onto `window.*` — every other RPC consumer reaches the
//      client via `useClients()` / `use<Method>` hooks. This file is a
//      compatibility shim for a renderer call site (`App.tsx:227`)
//      that the v0.3 cutover (#215) has not yet migrated; the surface
//      is intentionally one symbol.
//   2. node:* / web platform — N/A (this is renderer DOM glue).
//   3. No new dep introduced.
//   4. N/A.
//   5. Self-written (~50 LoC including the type bridge).

import type { CcsmClients } from '../rpc/clients.js';
import { create } from '@bufbuild/protobuf';
import {
  CheckClaudeAvailableRequestSchema,
  RequestMetaSchema,
} from '@ccsm/proto';

/**
 * Public shape of the polyfilled `window.ccsmPty.checkClaudeAvailable`
 * — mirrors `src/pty.d.ts`'s `CheckClaudeAvailableResult` discriminated
 * union exactly. Kept structurally compatible because the renderer
 * type declaration in `src/pty.d.ts` is the authoritative consumer
 * contract; updating it would force a cross-package dep that this
 * polyfill deliberately avoids.
 */
export type CheckClaudeAvailableResult =
  | { readonly available: true; readonly path: string }
  | { readonly available: false };

/**
 * Generate a per-call request_id. Uses `crypto.randomUUID()` (web
 * platform standard, available in Electron renderer) — the daemon's
 * `requestMetaInterceptor` rejects empty/whitespace-only ids, so we
 * never want to pass `''`.
 */
function newRequestId(): string {
  // Electron 41 ships Chromium 134; `crypto.randomUUID` is on every
  // supported renderer. Defensive fallback for the (vanishingly
  // unlikely) test environment that mocks `globalThis.crypto` to an
  // incomplete shape.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Sufficient for the daemon's "non-empty string" check; collision
  // probability over a session lifetime is irrelevant for a probe RPC.
  return `ccsm-pty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Install `window.ccsmPty.checkClaudeAvailable` against a typed
 * `PtyService` client. Call once after the clients bundle is built
 * (see `boot.tsx`'s `ColdStartGate`). Idempotent: re-installing
 * preserves any other `ccsmPty.*` surfaces that other modules / tests
 * have stitched onto the same object.
 *
 * The `opts.force` flag is accepted for renderer-source compatibility
 * with `src/components/ClaudeMissingGuide.tsx`'s recheck button, but
 * the daemon's resolver cache lives in-process on the daemon side and
 * is not exposed on the wire. Today the daemon always serves its
 * current cache; in practice the renderer's React Query layer is what
 * the "Re-check" UX needs to invalidate (the polyfill is unaware of
 * that layer because it has no access to the QueryClient at this
 * scope). The probe still hits the daemon RPC every call — there is
 * no renderer-side memoization here — so the user does see fresh
 * resolver state on every recheck click.
 */
export function installWindowCcsmPtyBridge(clients: CcsmClients): void {
  if (typeof window === 'undefined') return;

  const checkClaudeAvailable = async (
    _opts?: { force?: boolean },
  ): Promise<CheckClaudeAvailableResult> => {
    try {
      const req = create(CheckClaudeAvailableRequestSchema, {
        meta: create(RequestMetaSchema, {
          requestId: newRequestId(),
          clientVersion: 'ccsm-renderer/0.3',
          clientSendUnixMs: BigInt(Date.now()),
        }),
      });
      const res = await clients.pty.checkClaudeAvailable(req);
      if (res.available && res.resolvedPath.length > 0) {
        return { available: true, path: res.resolvedPath };
      }
      return { available: false };
    } catch (err) {
      // Connect transport / daemon errors fall through as "unavailable"
      // rather than throwing — the caller (App.tsx boot effect /
      // ClaudeMissingGuide recheck) treats throws as `false` already,
      // but normalizing here keeps the surface honest to the typed
      // return shape.
      // eslint-disable-next-line no-console
      console.debug('[ccsm/window-ccsm-pty] checkClaudeAvailable RPC failed:', err);
      return { available: false };
    }
  };

  const w = window as unknown as {
    ccsmPty?: Record<string, unknown>;
  };
  // Preserve any pre-existing surface (test stubs, future polyfills
  // for list/spawn/etc.); only graft `checkClaudeAvailable` on.
  const existing = w.ccsmPty ?? {};
  w.ccsmPty = { ...existing, checkClaudeAvailable };
}

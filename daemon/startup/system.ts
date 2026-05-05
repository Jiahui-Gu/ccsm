/**
 * Wave-2-C startup module: brings up the system-side daemon services that
 * wave-1 left dormant after main.ts shed its IPC handlers.
 *
 *  1. sessionWatcher — JSONL tail-watcher; emits state-changed / title-changed
 *     / unwatched events. Producer here, consumer is the SSE notify bridge
 *     (electron renderer subscribes via `/api/events/notify`).
 *  2. notify producer/decider — runStateTracker holds per-sid state. Wave-2-C
 *     does NOT own the OSC sniffer (PTY data still lives in the electron
 *     ptyHost until W2-B mv'es it). Until then the daemon exposes a
 *     `feedOsc` POST so any caller (wave-2-B's ptyHost-in-daemon, or the
 *     interim electron-side sniffer bridge) can push raw OSC titles through
 *     the same decider.
 *  3. badge state — per-sid unread counts; tray polls /api/badge/state.
 *
 * On `ctx.abort` we close down the watcher + flush badge state. The daemon
 * server tears down the HTTP listener separately.
 */

import { sessionWatcher } from "../sessionWatcher/index";
import { notifyHub } from "../notify/hub";
import { badgeStore } from "../notify/badgeStore";
import type { Startup } from "./types";

const start: Startup = (ctx) => {
  // Wire badge bumps off notify decisions. The hub fires a Decision per
  // qualifying OSC waiting transition; bump unread count so the tray badge
  // total reflects pending attention. Decision is also fanned out to SSE
  // subscribers separately (electron sinks toast/flash) — the listener
  // below is purely the badge side-effect.
  notifyHub.onDecision((d) => {
    if (d.toast || d.flash) {
      badgeStore.bump(d.sid);
    }
  });

  // Drain badge entries when a session is unwatched (PTY exit / kill).
  // sessionWatcher is the source of truth for "session is gone".
  sessionWatcher.on("unwatched", (evt: { sid?: unknown }) => {
    if (!evt || typeof evt.sid !== "string" || evt.sid.length === 0) return;
    badgeStore.forget(evt.sid);
    notifyHub.forgetSid(evt.sid);
  });

  ctx.abort.addEventListener("abort", () => {
    try {
      sessionWatcher.closeAll();
    } catch {
      /* best-effort */
    }
    notifyHub.dispose();
  });
};

export default start;


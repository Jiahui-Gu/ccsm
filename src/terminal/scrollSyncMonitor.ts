// src/terminal/scrollSyncMonitor.ts
//
// DIAGNOSTIC ONLY (gated behind CCSM_SCROLL_MONITOR=1) — a real-time probe
// for the #82-class desync the user reports on the real device: "CLI 内容和
// 侧边滚轮位置不一样" (the CLI content and the side scrollbar position don't
// match).
//
// Why a *live* monitor instead of a headless harness: the headless probes
// read state inside a single `win.evaluate` microtask, by which time xterm
// has already re-synced `.xterm-viewport.scrollTop` to its internal
// `viewportY`. So they always measure Δ≈0 and never catch the transient
// divergence the user actually sees. This monitor runs in the app's own
// rAF loop, sampling EVERY animation frame, so it catches the frame(s)
// where the two diverge.
//
// The desync dimension that matters:
//   - canvas content is rendered from xterm's internal `buffer.viewportY`
//     (which line is at the top of the screen)
//   - the native scrollbar thumb is drawn by webkit from the DOM element's
//     `.xterm-viewport.scrollTop`
// xterm keeps them in lockstep by writing `viewportY*cellHeight -> scrollTop`,
// but #82 is exactly the case where webkit zeroes/!-resets scrollTop on
// reflow/reparent WITHOUT xterm re-driving it, so the thumb (scrollTop) and
// the visible content (viewportY) point at different lines.
//
// We convert both to a line index and flag when they differ by more than a
// one-cell rounding tolerance. On a mismatch we log a loud `error(...)` through
// the shared renderer logger (so it lands in `renderer-logs/renderer.log`, not
// just DevTools) and flash an on-screen badge so the user can see whether the
// monitor fired at the exact moment they observed the visual mismatch.

import { warn, error } from '../shared/log';
import { getTopShell } from './shellRegistry';

const TOLERANCE_LINES = 1.5;

// Tag for the shared structured logger. Routing through `warn`/`error`
// (not bare `console.*`) makes the DESYNC line + heartbeat land in
// `userData/renderer-logs/renderer.log` via electron-log's file/IPC sinks,
// while ALSO printing the same human-readable `[scroll-monitor] ...` text to
// DevTools console (the shims do both). The user can read the log file after
// reproducing the real-device #82 desync. Bare `console.*` only reached
// DevTools and was never persisted.
const TAG = 'scroll-monitor';

let running = false;
let badge: HTMLDivElement | null = null;
let lastLogTs = 0;
let lastHeartbeatTs = 0;

function ensureBadge(): HTMLDivElement {
  if (badge) return badge;
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:2147483647;padding:6px 10px;' +
    'background:#c0202d;color:#fff;font:12px/1.3 monospace;border-radius:4px;' +
    'pointer-events:none;opacity:0;transition:opacity .12s;max-width:46ch;' +
    'white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.5)';
  document.body.appendChild(el);
  badge = el;
  return el;
}

function flash(msg: string): void {
  const el = ensureBadge();
  el.textContent = msg;
  el.style.opacity = '1';
  window.clearTimeout((el as unknown as { _t?: number })._t);
  (el as unknown as { _t?: number })._t = window.setTimeout(() => {
    el.style.opacity = '0';
  }, 1500);
}

function sample(): void {
  const shell = getTopShell();
  const term = shell?.term;
  const buf = term?.buffer?.active;
  // Scope the viewport lookup to the TOP shell's own wrapper. A global
  // `document.querySelector('.xterm-viewport')` grabs the FIRST viewport in
  // DOM order, which — with multiple alive-but-hidden shells parented in the
  // host — is often a HIDDEN shell's viewport, not the visible one. That read
  // the wrong scrollTop and masked the very desync the user can see.
  const vp = shell?.wrapper.querySelector('.xterm-viewport');
  if (!term || !buf || !(vp instanceof HTMLElement)) return;

  const baseY = buf.baseY;
  if (baseY <= 0) return; // no scrollback / alt-buffer — bar absent, vacuous

  const rows = term.rows;
  const viewportY = buf.viewportY; // line xterm's canvas actually renders at top
  const scrollHeight = vp.scrollHeight;
  const clientHeight = vp.clientHeight;
  const scrollTop = vp.scrollTop;

  // What line does the NATIVE scrollbar (scrollTop) point at? The viewport
  // spans (baseY + rows) lines over scrollHeight px, so one line ≈
  // scrollHeight/(baseY+rows) px. The line shown at scrollTop is therefore:
  const cell = scrollHeight / (baseY + rows);
  if (!(cell > 0)) return;
  const scrollbarLine = scrollTop / cell;

  const deltaLines = Math.abs(scrollbarLine - viewportY);
  if (deltaLines <= TOLERANCE_LINES) {
    // Heartbeat every ~2s while synced: proves the monitor is sampling the
    // RIGHT element. If the user sees a visible desync but the heartbeat keeps
    // logging Δ≈0, the measured dimension itself is still wrong (not just the
    // element). `vpCount` exposes how many viewports are alive so we can tell
    // whether the old global querySelector was reading a sibling shell.
    const now = Date.now();
    if (now - lastHeartbeatTs > 2000) {
      lastHeartbeatTs = now;
      const vpCount = document.querySelectorAll('.xterm-viewport').length;
      warn(
        TAG,
        `ok sid=${shell?.sid} vpCount=${vpCount} ` +
          `bar→line ${scrollbarLine.toFixed(1)} content→line ${viewportY} ` +
          `Δ=${deltaLines.toFixed(2)} | baseY=${baseY} viewportY=${viewportY} ` +
          `scrollTop=${scrollTop} scrollHeight=${scrollHeight} clientHeight=${clientHeight}`,
      );
    }
    return;
  }

  // Mismatch: the thumb (scrollTop) and the rendered content (viewportY)
  // disagree about which line is on screen.
  const now = Date.now();
  if (now - lastLogTs > 250) {
    lastLogTs = now;
    error(
      TAG,
      `DESYNC: scrollbar points at line ${scrollbarLine.toFixed(1)} ` +
        `but CLI content is rendered at line ${viewportY} ` +
        `(Δ=${deltaLines.toFixed(1)} lines) | baseY=${baseY} rows=${rows} ` +
        `scrollTop=${scrollTop} scrollHeight=${scrollHeight} clientHeight=${clientHeight} cell=${cell.toFixed(2)}`,
    );
    flash(
      `SCROLL DESYNC\nbar→line ${scrollbarLine.toFixed(0)}  ` +
        `content→line ${viewportY}\nΔ=${deltaLines.toFixed(1)} lines`,
    );
  }
}

function loop(): void {
  if (!running) return;
  try {
    sample();
  } catch {
    /* diagnostic best-effort */
  }
  requestAnimationFrame(loop);
}

/**
 * Start the live scroll-sync monitor. Idempotent. Gated by the caller on
 * the CCSM_SCROLL_MONITOR flag so it never runs in production.
 */
export function startScrollSyncMonitor(): void {
  if (running) return;
  running = true;
  warn(TAG, 'started — sampling scrollbar vs CLI content every frame');
  requestAnimationFrame(loop);
}

export function stopScrollSyncMonitor(): void {
  running = false;
}

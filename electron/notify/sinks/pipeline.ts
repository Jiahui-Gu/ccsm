// Notify pipeline orchestrator (Phase C, Task #689).
//
// Wires the four phase-decoupled pieces of the new notify architecture:
//
//   producer  : OscTitleSniffer (#688, dual-mode OSC 0+2 since #713) —
//               feeds raw titles per sid.
//   decider   : notifyDecider.decide(event, ctx) (#687) — pure 7-rule eval.
//   sink #1   : toastSink — fires Electron Notification.
//   sink #2   : flashSink — pushes transient flash state to renderer.
//
// This file owns the mutable `Ctx` (focused / activeSid / lastUserInputTs /
// runStartTs / mutedSids / lastFiredTs) and is the ONLY place that mutates
// it. The decider stays pure; the sinks stay single-responsibility.
//
// Lifecycle inputs (from main.ts):
//   * `feedChunk(sid, chunk)`         — every PTY chunk from ptyHost.
//   * `markUserInput(sid)`            — new/import/resume/select-session IPC.
//   * `setActiveSid(sid)`             — renderer's session:setActive mirror.
//   * `setFocused(focused)`           — BrowserWindow focus/blur.
//   * `setMuted(sid, muted)`          — per-sid mute toggle (future surface).
//   * `forgetSid(sid)`                — session teardown cleanup.
//
// Wire side-effects: the sniffer's 'osc-title' event drives the central
// decision loop. Run-state is updated based on the title text — a 'running'
// title kicks runStartTs, a 'waiting'/'idle' title triggers a decide() call
// (and the runStartTs is left in place so the decider can compute elapsed).

import type { BrowserWindow } from 'electron';
import { OscTitleSniffer, type OscTitleEvent } from '../../ptyHost/oscTitleSniffer';
import { decide, type Ctx, type Decision } from '../notifyDecider';
import { classifyTitleState } from '../titleStateClassifier';
import { createToastSink, type ToastSink, type ToastSinkOptions } from './toastSink';
import { createFlashSink, type FlashSink } from './flashSink';

export interface NotifyPipelineOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Returns true iff notifications are globally muted (user pref).
   *  The decider doesn't read this — global mute is enforced as a top-level
   *  short-circuit before decide() so muted sids don't even count for
   *  dedupe. */
  isGlobalMutedFn: () => boolean;
  /** Same name resolver the legacy bridge uses. Passed through to toastSink. */
  getNameFn?: ToastSinkOptions['getNameFn'];
  /** Bump unread badge counter when a toast fires. */
  onNotified?: (sid: string) => void;
}

export interface PipelineDiag {
  bytesFed: number;
  chunksFed: number;
  snifferEvents: number;
  titlesSeen: string[];
  classifications: { idle: number; running: number; unknown: number };
  decideCalls: number;
  decisions: number;
}

export interface NotifyPipeline {
  /** Feed a PTY chunk for `sid` into the OSC sniffer. */
  feedChunk(sid: string, chunk: string | Buffer): void;
  /** Record a user-initiated touch on `sid` (Rule 1 input). */
  markUserInput(sid: string): void;
  /** Renderer pushed a new active sid via 'session:setActive'. */
  setActiveSid(sid: string | null): void;
  /** BrowserWindow focus/blur. */
  setFocused(focused: boolean): void;
  /** Per-sid mute toggle (Rule 7). */
  setMuted(sid: string, muted: boolean): void;
  /** Session teardown — drop sniffer buffer + ctx entries + flash timer. */
  forgetSid(sid: string): void;
  /** Tear down all listeners and timers (test cleanup). */
  dispose(): void;
  /** Test-only — direct access to internals for assertion. */
  _internals(): {
    ctx: Ctx;
    sniffer: OscTitleSniffer;
    toast: ToastSink;
    flash: FlashSink;
    /** Diag counters; populated only when `globalThis.__ccsmDebug` is truthy. */
    diag: PipelineDiag | null;
  };
}

// Heuristic: a 'running' OSC title indicates the CLI is mid-turn. The CLI
// emits braille-spinner glyphs (e.g. "⠼") around the verb word during a
// run; we treat any title containing one of those glyphs OR the word
// 'running' as the running signal. Permissive on purpose — the decider
// only uses runStartTs for the 60s short-task threshold; over-counting a
// run as starting earlier is harmless.
const RUNNING_BRAILLE_RE = /[⠀-⣿]/;
function isRunningTitle(title: string): boolean {
  return RUNNING_BRAILLE_RE.test(title) || /running/i.test(title);
}

// Decider's `isWaitingTitle` matches the literal word "waiting", but the
// real CLI encodes idle/waiting via the leading sparkle glyph (U+2733).
// Synthesize a normalized title the decider can match by replacing the
// raw glyph-encoded title with the word "waiting" when classification
// indicates the CLI is idle (= user attention required).
function normalizeForDecider(rawTitle: string): string | null {
  const cls = classifyTitleState(rawTitle);
  if (cls === 'idle') return 'waiting'; // sparkle → user-attention
  return null; // running / unknown — no decision input
}

export function installNotifyPipeline(opts: NotifyPipelineOptions): NotifyPipeline {
  const sniffer = new OscTitleSniffer();
  const toast = createToastSink({
    getMainWindow: opts.getMainWindow,
    getNameFn: opts.getNameFn,
    onNotified: opts.onNotified,
  });
  const flash = createFlashSink({ getMainWindow: opts.getMainWindow });
  const ctx: Ctx = {
    focused: true, // assume focused at boot until BrowserWindow tells us otherwise
    activeSid: null,
    lastUserInputTs: new Map<string, number>(),
    runStartTs: new Map<string, number>(),
    mutedSids: new Set<string>(),
    lastFiredTs: new Map<string, number>(),
    now: Date.now(),
  };

  function refreshNow(): void {
    ctx.now = Date.now();
  }

  // Diagnostics for e2e probes — counts what each layer sees so we can tell
  // whether failure is "no PTY data", "no OSC titles", "titles seen but
  // unclassifiable", or "decider rejected". Production builds skip the
  // counters entirely; the diag block only allocates when a probe sets
  // `globalThis.__ccsmDebug = true` before installing the pipeline.
  const debugEnabled = Boolean((globalThis as { __ccsmDebug?: unknown }).__ccsmDebug);
  const diag: PipelineDiag | null = debugEnabled
    ? {
        bytesFed: 0,
        chunksFed: 0,
        snifferEvents: 0,
        titlesSeen: [],
        classifications: { idle: 0, running: 0, unknown: 0 },
        decideCalls: 0,
        decisions: 0,
      }
    : null;
  function recordTitle(title: string): void {
    if (!diag) return;
    diag.titlesSeen.push(title);
    if (diag.titlesSeen.length > 10) diag.titlesSeen.shift();
  }

  const onOsc = (evt: OscTitleEvent): void => {
    refreshNow();
    if (diag) diag.snifferEvents += 1;
    recordTitle(evt.title);
    const cls = classifyTitleState(evt.title);
    if (diag) {
      if (cls === 'idle') diag.classifications.idle += 1;
      else if (cls === 'running') diag.classifications.running += 1;
      else diag.classifications.unknown += 1;
    }
    // Maintain runStartTs from running titles (used by Rule 2/3 elapsed).
    if (isRunningTitle(evt.title)) {
      if (!ctx.runStartTs.has(evt.sid)) {
        ctx.runStartTs.set(evt.sid, ctx.now);
      }
      // Don't decide on running titles — only on waiting transitions.
      return;
    }

    // Translate the raw glyph-encoded CLI title into the keyword the
    // decider matches against. Returns null for non-decision titles
    // (running already handled above; unknown / boot titles ignored).
    const normalized = normalizeForDecider(evt.title);
    if (normalized === null) {
      return;
    }

    // Global mute short-circuit. Skip decide() entirely so global-muted
    // events don't poison dedupe state.
    if (opts.isGlobalMutedFn()) {
      // Still clear runStartTs on non-running titles so the next run starts
      // fresh.
      ctx.runStartTs.delete(evt.sid);
      return;
    }

    const decision: Decision | null = decide(
      { type: 'osc-title', sid: evt.sid, title: normalized, ts: evt.ts },
      ctx,
    );
    if (diag) {
      diag.decideCalls += 1;
      if (decision) diag.decisions += 1;
    }

    // Clear run start on waiting/idle (after decide so the elapsed reading
    // is computed against the current run).
    ctx.runStartTs.delete(evt.sid);

    if (!decision) return;
    ctx.lastFiredTs.set(decision.sid, ctx.now);
    toast.apply(decision);
    flash.apply(decision);
  };

  sniffer.on('osc-title', onOsc);

  return {
    feedChunk(sid, chunk) {
      if (diag) {
        diag.chunksFed += 1;
        diag.bytesFed += typeof chunk === 'string' ? chunk.length : chunk.length;
      }
      sniffer.feed(sid, chunk);
    },
    markUserInput(sid) {
      refreshNow();
      ctx.lastUserInputTs.set(sid, ctx.now);
    },
    setActiveSid(sid) {
      ctx.activeSid = sid;
    },
    setFocused(focused) {
      ctx.focused = focused;
    },
    setMuted(sid, muted) {
      if (muted) ctx.mutedSids.add(sid);
      else ctx.mutedSids.delete(sid);
    },
    forgetSid(sid) {
      sniffer.clear(sid);
      ctx.lastUserInputTs.delete(sid);
      ctx.runStartTs.delete(sid);
      ctx.mutedSids.delete(sid);
      ctx.lastFiredTs.delete(sid);
      flash.forget(sid);
    },
    dispose() {
      sniffer.off('osc-title', onOsc);
      sniffer.removeAllListeners();
    },
    _internals() {
      return { ctx, sniffer, toast, flash, diag };
    },
  };
}

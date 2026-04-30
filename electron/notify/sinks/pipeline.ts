// Notify pipeline orchestrator (Task #743 Phase B).
//
// Thin wiring layer over the three single-responsibility pieces of the
// notify subsystem:
//
//   producer : OscTitleSniffer (#688, dual-mode OSC 0+2 since #713) — feeds
//              raw titles per sid.
//   decider  : runStateTracker (#721/#551) — owns per-sid run state, mute
//              windows, dedupe, and calls notifyDecider.decide() with a
//              synthesized Ctx. Pure module, no side effects.
//   sinks    : toastSink (Electron Notification) + flashSink (renderer
//              flash state). Each is single-responsibility.
//
// This file no longer owns any per-sid state — pipeline.ts is now strictly
// "subscribe sniffer → tracker.onTitle(...) → fan out decision to sinks".
// Lifecycle setters (markUserInput / setActiveSid / setFocused / setMuted /
// forgetSid) are forwarded straight to the tracker.

import type { BrowserWindow } from 'electron';
import { OscTitleSniffer, type OscTitleEvent } from '../../ptyHost/oscTitleSniffer';
import { decide, type Ctx } from '../notifyDecider';
import { createRunStateTracker, type RunStateTracker } from '../runStateTracker';
import { classifyTitleState } from '../titleStateClassifier';
import { createToastSink, type ToastSink, type ToastSinkOptions } from './toastSink';
import { createFlashSink, type FlashSink } from './flashSink';

export interface NotifyPipelineOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Returns true iff notifications are globally muted (user pref).
   *  The decider doesn't read this — global mute is enforced as a top-level
   *  short-circuit before the tracker runs so muted sids don't even count
   *  for dedupe. */
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
  /** Session teardown — drop sniffer buffer + tracker entries + flash timer. */
  forgetSid(sid: string): void;
  /** Tear down all listeners and timers (test cleanup). */
  dispose(): void;
  /** Test-only — direct access to internals for assertion. The `ctx`
   *  projection mirrors the historical pipeline-owned shape so existing
   *  e2e probes continue to read familiar fields. */
  _internals(): {
    ctx: Ctx;
    sniffer: OscTitleSniffer;
    tracker: RunStateTracker;
    toast: ToastSink;
    flash: FlashSink;
    /** Diag counters; populated only when `globalThis.__ccsmDebug` is truthy. */
    diag: PipelineDiag | null;
  };
}

export function installNotifyPipeline(opts: NotifyPipelineOptions): NotifyPipeline {
  const sniffer = new OscTitleSniffer();
  const toast = createToastSink({
    getMainWindow: opts.getMainWindow,
    getNameFn: opts.getNameFn,
    onNotified: opts.onNotified,
  });
  const flash = createFlashSink({ getMainWindow: opts.getMainWindow });
  const tracker = createRunStateTracker(decide);

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
    const now = Date.now();
    if (diag) diag.snifferEvents += 1;
    recordTitle(evt.title);
    const cls = classifyTitleState(evt.title);
    if (diag) {
      if (cls === 'idle') diag.classifications.idle += 1;
      else if (cls === 'running') diag.classifications.running += 1;
      else diag.classifications.unknown += 1;
    }

    // Global mute short-circuit. Skip tracker entirely on idle so
    // global-muted events don't poison dedupe or runStartTs state. Forget
    // the sid so the next run starts fresh on un-mute.
    if (cls === 'idle' && opts.isGlobalMutedFn()) {
      tracker.forgetSid(evt.sid);
      return;
    }

    if (diag && cls === 'idle') diag.decideCalls += 1;
    const decision = tracker.onTitle(evt.sid, cls, now);
    if (decision) {
      if (diag) diag.decisions += 1;
      toast.apply(decision);
      flash.apply(decision);
    }
  };

  sniffer.on('osc-title', onOsc);

  // Project the tracker's internal state into the historical Ctx shape so
  // the e2e test seam (and any future inspector) can read it without
  // knowing about the tracker abstraction.
  function projectCtx(): Ctx {
    const i = tracker._internals();
    const now = Date.now();
    const activeMuted = new Set<string>();
    for (const [sid, until] of i.mutedSids) {
      if (now < until) activeMuted.add(sid);
    }
    return {
      focused: i.focused,
      activeSid: i.activeSid,
      lastUserInputTs: i.lastUserInputTs,
      runStartTs: i.runStartTs,
      mutedSids: activeMuted,
      lastFiredTs: i.lastFiredTs,
      now,
    };
  }

  return {
    feedChunk(sid, chunk) {
      if (diag) {
        diag.chunksFed += 1;
        diag.bytesFed += typeof chunk === 'string' ? chunk.length : chunk.length;
      }
      sniffer.feed(sid, chunk);
    },
    markUserInput(sid) {
      // Per #721 reviewer note: pipeline's markUserInput bridges to a
      // sticky mute on the tracker. A sid the user just touched (created /
      // imported / resumed) should not produce attention toasts until the
      // session is torn down (forgetSid clears the mute) or an explicit
      // un-mute lands. This supersedes the decider's Rule 1 60s window
      // for the create/import/resume IPC paths that go through here.
      //
      // audit #876 cluster 2.2: this is a HIDDEN SIDE EFFECT — the method
      // name reads as "remember a user input event" but the actual
      // operation is `setMuted(sid, +Infinity)`, i.e. PERMANENT mute on
      // that sid. Cleared only by forgetSid (session teardown) or explicit
      // setMuted(sid, false). If you rename or refactor this, surface the
      // mute semantics in the new name (e.g. `markUserInitAndMute`).
      tracker.setMuted(sid, Number.POSITIVE_INFINITY);
    },
    setActiveSid(sid) {
      tracker.setActiveSid(sid);
    },
    setFocused(focused) {
      tracker.setFocused(focused);
    },
    setMuted(sid, muted) {
      tracker.setMuted(sid, muted ? Number.POSITIVE_INFINITY : null);
    },
    forgetSid(sid) {
      sniffer.clear(sid);
      tracker.forgetSid(sid);
      flash.forget(sid);
    },
    dispose() {
      sniffer.off('osc-title', onOsc);
      sniffer.removeAllListeners();
      // Tear down per-sid flash timers (audit #876 cluster 1.14 / Task #884).
      // Without this, every still-flashing sid leaks its `setTimeout` handle
      // (unref'd, but the closure still pins flashSink internals) past
      // pipeline disposal — visible as a slow-growing handle count in
      // long-running tests / HMR reloads.
      flash.dispose();
    },
    _internals() {
      return { ctx: projectCtx(), sniffer, tracker, toast, flash, diag };
    },
  };
}

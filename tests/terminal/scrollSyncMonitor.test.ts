// Tests for the diagnostic scroll-sync monitor (src/terminal/scrollSyncMonitor.ts).
//
// The monitor exists to catch the #82-class native-scrollbar desync the user
// reports on a real device. Crucially, its output must be PERSISTED — bare
// `console.*` only reaches DevTools and is never written to any log file. This
// suite locks in the contract that the DESYNC line and the synced heartbeat
// both route through the shared renderer logger (`warn`/`error` from
// `src/shared/log`), which mirrors records over IPC to the main process and
// writes them to `userData/renderer-logs/renderer.log`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the shared logger so we can assert the monitor routes through it (not
// bare console). The real `warn`/`error` shims ALSO print to console, so
// routing through them keeps the recognizable `[scroll-monitor] ...` DevTools
// text while persisting to the file/IPC sinks.
const { warnSpy, errorSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}));
vi.mock('../../src/shared/log', () => ({
  warn: warnSpy,
  error: errorSpy,
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the shell registry so we can hand the monitor a synthetic top shell
// whose viewport / xterm buffer we fully control.
const { getTopShellSpy } = vi.hoisted(() => ({ getTopShellSpy: vi.fn() }));
vi.mock('../../src/terminal/shellRegistry', () => ({
  getTopShell: getTopShellSpy,
}));

import {
  startScrollSyncMonitor,
  stopScrollSyncMonitor,
} from '../../src/terminal/scrollSyncMonitor';

type FakeViewport = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Build a fake top shell with a controllable viewport + xterm buffer. */
function makeShell(opts: {
  sid: string;
  baseY: number;
  viewportY: number;
  rows: number;
  vp: FakeViewport;
}) {
  const viewportEl = document.createElement('div');
  Object.defineProperties(viewportEl, {
    scrollTop: { value: opts.vp.scrollTop, configurable: true },
    scrollHeight: { value: opts.vp.scrollHeight, configurable: true },
    clientHeight: { value: opts.vp.clientHeight, configurable: true },
  });
  viewportEl.className = 'xterm-viewport';

  const wrapper = document.createElement('div');
  wrapper.appendChild(viewportEl);
  // The monitor scopes its lookup to the shell's OWN wrapper via
  // wrapper.querySelector('.xterm-viewport'); jsdom honours that.
  document.body.appendChild(wrapper);

  return {
    sid: opts.sid,
    wrapper,
    term: {
      rows: opts.rows,
      buffer: { active: { baseY: opts.baseY, viewportY: opts.viewportY } },
    },
  };
}

describe('scrollSyncMonitor logging routing', () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
    getTopShellSpy.mockReset();
    document.body.innerHTML = '';
    // Drive the rAF loop deterministically: run the callback exactly once so
    // a single sample() executes, then stop (return 0 = no further scheduling
    // because the monitor checks `running` on re-entry, which we control).
    let fired = false;
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      if (!fired) {
        fired = true;
        cb(performance.now());
      }
      return 0;
    });
  });

  afterEach(() => {
    stopScrollSyncMonitor();
    rafSpy.mockRestore();
    vi.useRealTimers();
  });

  it('routes a DESYNC through the shared logger error() (not bare console)', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    // scrollHeight/(baseY+rows) = 1000/100 = 10 px/line. scrollTop=0 → bar at
    // line 0, but content is rendered at viewportY=50 → Δ=50 lines >> 1.5.
    getTopShellSpy.mockReturnValue(
      makeShell({
        sid: 'sid-A',
        baseY: 90,
        viewportY: 50,
        rows: 10,
        vp: { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 },
      }),
    );

    startScrollSyncMonitor();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [tag, msg] = errorSpy.mock.calls[0];
    expect(tag).toBe('scroll-monitor');
    // Recognizable text the user / probe greps for ("[scroll-monitor] DESYNC").
    // The shim prefixes "[scroll-monitor] ", so the message itself starts with
    // "DESYNC:".
    expect(msg).toMatch(/^DESYNC: scrollbar points at line 0\.0 but CLI content is rendered at line 50/);
    // The monitor must NOT use bare console.error for the DESYNC line — that
    // was the bug (never persisted to renderer.log).
    expect(consoleErr).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('routes the synced heartbeat through the shared logger warn() (not bare console)', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // bar line = scrollTop/(scrollHeight/(baseY+rows)) = 500/(1000/100) = 50,
    // content viewportY = 50 → Δ=0 ≤ 1.5 → synced → heartbeat.
    getTopShellSpy.mockReturnValue(
      makeShell({
        sid: 'sid-B',
        baseY: 90,
        viewportY: 50,
        rows: 10,
        vp: { scrollTop: 500, scrollHeight: 1000, clientHeight: 100 },
      }),
    );

    startScrollSyncMonitor();

    // First warn() is the "started" line, then the heartbeat — both via the
    // shared logger. Assert at least one carries the heartbeat text.
    const heartbeat = warnSpy.mock.calls.find(
      ([tag, msg]) => tag === 'scroll-monitor' && /^ok sid=sid-B/.test(String(msg)),
    );
    expect(heartbeat).toBeDefined();
    // The "started" announcement also goes through the shared logger.
    const started = warnSpy.mock.calls.find(
      ([tag, msg]) => tag === 'scroll-monitor' && /^started/.test(String(msg)),
    );
    expect(started).toBeDefined();
    // No bare console.warn for monitor output.
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

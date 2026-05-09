// Task #89 (R-31) — koffi-based Win32 console-state probes for PTY spawn
// forensics. R-30 (Plan A: Tauri CREATE_NEW_CONSOLE + daemon-side
// ShowWindow(GetConsoleWindow, SW_HIDE) via koffi) failed: spawn #2 still
// hits `AttachConsole failed` in node-pty's conpty_console_list_agent.js,
// identical to R-29 baseline. That falsifies R-30's root-cause hypothesis
// (daemon has no console at startup → first spawn implicitly AllocConsole-
// binds → second spawn cannot AttachConsole).
//
// Two surviving hypotheses (PR #1203 body):
//   H1 — CreatePseudoConsole for spawn #1 binds the daemon process to
//        HPCON#1's console group at a level deeper than FreeConsole
//        releases. Helper subprocess for spawn #2 inherits that binding;
//        AttachConsole(pid2) returns ERROR_ACCESS_DENIED because daemon
//        (parent) is still bound to HPCON#1.
//   H2 — getConsoleProcessList itself has destructive side effects on
//        daemon console state.
//
// To distinguish H1 vs H2 we expose two pure read probes from runtime.mts:
//   - getConsoleHwnd(): GetConsoleWindow → integer hwnd or null
//   - getConsoleProcessList(): GetConsoleProcessList → { count, pids }
//
// Both stubs no-op on non-Windows so importing this module on darwin/linux
// is safe.

import { createRequire } from 'node:module';

interface KoffiLib {
  func(signature: string): (...args: unknown[]) => unknown;
}

interface KoffiModule {
  load(name: string): KoffiLib;
  // koffi's typed-array / out-buffer support
  alloc(type: string, count: number): Uint8Array;
  // Note: we use Buffer.alloc for the DWORD array argument since koffi
  // accepts Node Buffers as raw output buffers when the C signature is a
  // pointer.
}

let cached: {
  getConsoleWindow: (() => number) | null;
  getConsoleProcessList: ((buf: Buffer, len: number) => number) | null;
} | null = null;

function getApis(): {
  getConsoleWindow: (() => number) | null;
  getConsoleProcessList: ((buf: Buffer, len: number) => number) | null;
} {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    cached = { getConsoleWindow: null, getConsoleProcessList: null };
    return cached;
  }
  try {
    const requireCjs = createRequire(import.meta.url);
    const koffi = requireCjs('koffi') as KoffiModule;
    const kernel32 = koffi.load('kernel32.dll');
    // HWND GetConsoleWindow(void)
    const fnGetConsoleWindow = kernel32.func('void* __stdcall GetConsoleWindow()') as () => unknown;
    // DWORD GetConsoleProcessList(LPDWORD lpdwProcessList, DWORD dwProcessCount)
    const fnGetConsoleProcessList = kernel32.func(
      'uint32 __stdcall GetConsoleProcessList(_Out_ uint32 *lpdwProcessList, uint32 dwProcessCount)',
    ) as (buf: Buffer, len: number) => number;
    cached = {
      getConsoleWindow: () => {
        const v = fnGetConsoleWindow() as number | bigint | null;
        if (v === null || v === undefined) return 0;
        if (typeof v === 'bigint') return Number(v);
        return v as number;
      },
      getConsoleProcessList: fnGetConsoleProcessList,
    };
  } catch {
    cached = { getConsoleWindow: null, getConsoleProcessList: null };
  }
  return cached;
}

/**
 * Wraps Win32 GetConsoleWindow. Returns hwnd as integer (may be large on
 * x64) or null when there is no attached console / call failed / non-Windows.
 */
export function getConsoleHwnd(): number | null {
  const { getConsoleWindow } = getApis();
  if (!getConsoleWindow) return null;
  try {
    const hwnd = getConsoleWindow();
    if (!hwnd || hwnd === 0) return null;
    return hwnd;
  } catch {
    return null;
  }
}

/**
 * Wraps Win32 GetConsoleProcessList. Returns the count and the list of
 * pids attached to the caller's console. Adaptive: starts with a 32-slot
 * buffer; if the API reports it needs more, retries once with the reported
 * size. Returns { count: 0, pids: [] } on non-Windows / failure / no
 * attached console.
 */
export function getConsoleProcessList(): { count: number; pids: number[] } {
  const { getConsoleProcessList: fn } = getApis();
  if (!fn) return { count: 0, pids: [] };
  try {
    const initialLen = 32;
    const buf = Buffer.alloc(initialLen * 4); // DWORD = 4 bytes
    const ret = fn(buf, initialLen);
    if (!ret || ret === 0) {
      return { count: 0, pids: [] };
    }
    if (ret <= initialLen) {
      const pids: number[] = [];
      for (let i = 0; i < ret; i++) {
        pids.push(buf.readUInt32LE(i * 4));
      }
      return { count: ret, pids };
    }
    // Need a bigger buffer — retry once with reported size.
    const buf2 = Buffer.alloc(ret * 4);
    const ret2 = fn(buf2, ret);
    if (!ret2 || ret2 === 0 || ret2 > ret) {
      return { count: ret, pids: [] };
    }
    const pids: number[] = [];
    for (let i = 0; i < ret2; i++) {
      pids.push(buf2.readUInt32LE(i * 4));
    }
    return { count: ret2, pids };
  } catch {
    return { count: 0, pids: [] };
  }
}

// R-9 v3.D — Win32 Job Object wrapper for smoke fixtures.
//
// R-14 (Task #34) widened the scope: this Job now wraps **all three**
// smoke-spawned process trees, not just Tauri:
//   1. cf-worker — `pnpm exec wrangler dev` → wrangler.cmd shim → node →
//      workerd. The shim and node are short-lived but workerd is a long-lived
//      child; without the Job, killing the cmd shim leaves workerd as an
//      orphan holding port 8787.
//   2. pages-dev — `pnpm exec wrangler pages dev` → same shim → node →
//      workerd, plus a Functions worker for `[[path]].ts`.
//   3. tauri — ccsm-tauri.exe + webview helper + wry sandbox + the daemon
//      Node child spawned by lib.rs setup hook.
// Pids of all three are assigned via `smokeJob.assign()` in the orchestrator
// immediately after `child.spawn()`, before awaiting readyMatch. This means
// any setup-failure path (readyMatch timeout, HTTP-stable timeout, anything
// that throws between spawn and ready) still tears the whole tree on
// `smokeJob.close()` in globalTeardown — no leaked workerd / wrangler shim.
//
// Why we need this on top of `child.kill()` in orchestrator's killHandle():
// - Tauri's release .exe spawns multiple child processes (webview helper,
//   wry sandbox, the embedded daemon Node process) that are NOT killed when
//   the parent ccsm-tauri.exe receives a `child.kill()` from Node — Windows
//   has no SIGTERM, and `child.kill()` defaults to TerminateProcess on the
//   ccsm-tauri.exe pid only. The descendants survive as zombies, holding a
//   filesystem lock on `.fixtures/bin/ccsm-tauri.exe` (because the .exe text
//   image is mapped into them via shared sections), which then makes the
//   next `pnpm smoke:build` T4 copyfile fail with EBUSY.
// - The same problem applies to wrangler shims (pnpm.cmd → wrangler.cmd →
//   node.exe → workerd.exe). `child.kill()` on the cmd shim leaves workerd
//   listening on the smoke port, which makes the next smoke run fail at
//   `EADDRINUSE` on 8787/8788. R-14 fixes this by enrolling the cmd shim's
//   pid in the same Job Object — KILL_ON_JOB_CLOSE then propagates to
//   workerd because the Job association inherits to descendants (we do NOT
//   set JOB_OBJECT_LIMIT_BREAKAWAY_OK).
// - The Tauri Rust side has its own Job Object (T9, see
//   packages/frontend-tauri/src-tauri/src/job_object.rs) but that one only
//   reaps the *daemon* child of Tauri, not the Tauri exe itself or its
//   webview helpers. From the smoke orchestrator's POV, we are the *parent*
//   of ccsm-tauri.exe, so we are the layer responsible for binding the whole
//   Tauri process tree to a Job that kernel-kills on Job-handle close.
//
// Mechanism: create one Win32 Job Object per smoke run with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Assign the spawned child pid via
// AssignProcessToJobObject. When the smoke process exits (graceful or
// crash) the kernel closes our handle, which atomically terminates every
// process in the Job — including descendants started after assignment, per
// MSDN ("processes assigned to a job inherit the job association unless
// JOB_OBJECT_LIMIT_BREAKAWAY_OK is set, which we do not set").
//
// FFI choice: we use `koffi` (MIT, 0 deps, actively maintained — last
// publish 2026-05) to call kernel32 + kernel32 JobObjects entry points. We
// considered:
//   - native node-gyp addon: heavy build chain (msvc), failure mode worse
//     than the bug we're fixing
//   - PowerShell + Add-Type: per-spawn process overhead, brittle
//   - `windows-job-object` npm: does not exist on the registry (verified
//     2026-05-08)
//   - `win32-api` npm: depends on koffi anyway and has a much wider surface
//     than we need; using koffi directly is leaner
//
// On non-Windows this module is a no-op stub: smoke is Windows-first per
// project_smoke_windows_zombie_lock_2026_05_08.md, and POSIX kill semantics
// already cascade via process groups.
import koffi from 'koffi';

const IS_WINDOWS = process.platform === 'win32';

export interface SmokeJobObject {
  /** Assign a child pid (after spawn) to the Job. */
  assign(pid: number): void;
  /** Close the Job handle, which (under KILL_ON_JOB_CLOSE) kernel-kills every assigned descendant. */
  close(): void;
}

interface Kernel32Bindings {
  CreateJobObjectW: (lpJobAttributes: unknown, lpName: unknown) => unknown;
  SetInformationJobObject: (
    hJob: unknown,
    JobObjectInformationClass: number,
    lpJobObjectInformation: unknown,
    cbJobObjectInformationLength: number,
  ) => number;
  AssignProcessToJobObject: (hJob: unknown, hProcess: unknown) => number;
  OpenProcess: (dwDesiredAccess: number, bInheritHandle: number, dwProcessId: number) => unknown;
  CloseHandle: (hObject: unknown) => number;
  GetLastError: () => number;
}

// Lazily bind so non-Windows never tries to load kernel32.
let bindings: Kernel32Bindings | null = null;

function getBindings(): Kernel32Bindings {
  if (bindings !== null) return bindings;
  const lib = koffi.load('kernel32.dll');

  // Win32 type aliases. koffi understands native widths.
  // HANDLE / BOOL / DWORD all map to platform-native ints; we use uintptr_t /
  // int / uint32 explicitly so cross-arch (x64) is correct.
  bindings = {
    // HANDLE CreateJobObjectW(LPSECURITY_ATTRIBUTES lpJobAttributes, LPCWSTR lpName)
    CreateJobObjectW: lib.func('void* __stdcall CreateJobObjectW(void*, void*)'),
    // BOOL SetInformationJobObject(HANDLE, JOBOBJECTINFOCLASS, LPVOID, DWORD)
    SetInformationJobObject: lib.func(
      'int __stdcall SetInformationJobObject(void*, int, void*, uint32)',
    ),
    // BOOL AssignProcessToJobObject(HANDLE hJob, HANDLE hProcess)
    AssignProcessToJobObject: lib.func(
      'int __stdcall AssignProcessToJobObject(void*, void*)',
    ),
    // HANDLE OpenProcess(DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwProcessId)
    OpenProcess: lib.func('void* __stdcall OpenProcess(uint32, int, uint32)'),
    // BOOL CloseHandle(HANDLE)
    CloseHandle: lib.func('int __stdcall CloseHandle(void*)'),
    // DWORD GetLastError(void)
    GetLastError: lib.func('uint32 __stdcall GetLastError()'),
  };
  return bindings;
}

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout. We only need to set
// LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Rest is zero-initialized.
//
// struct JOBOBJECT_BASIC_LIMIT_INFORMATION { // 48 bytes on x64
//   LARGE_INTEGER PerProcessUserTimeLimit;   //  8
//   LARGE_INTEGER PerJobUserTimeLimit;       //  8
//   DWORD         LimitFlags;                //  4
//   SIZE_T        MinimumWorkingSetSize;     //  8 (x64)
//   SIZE_T        MaximumWorkingSetSize;     //  8
//   DWORD         ActiveProcessLimit;        //  4
//   ULONG_PTR     Affinity;                  //  8
//   DWORD         PriorityClass;             //  4
//   DWORD         SchedulingClass;           //  4
// };  // total = 8+8+4+8+8+4+8+4+4 = 56, but with alignment LimitFlags is at offset 16
//
// struct IO_COUNTERS { ULONGLONG x6; }       // 48
// struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
//   JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; // 56 (with align)
//   IO_COUNTERS                       IoInfo;                // 48
//   SIZE_T                            ProcessMemoryLimit;    //  8
//   SIZE_T                            JobMemoryLimit;        //  8
//   SIZE_T                            PeakProcessMemoryUsed; //  8
//   SIZE_T                            PeakJobMemoryUsed;     //  8
// };
//
// On x64 with 8-byte alignment: BasicLimitInformation occupies 64 bytes
// (LimitFlags at offset 16, MinimumWorkingSetSize aligned to 24, ...
// SchedulingClass at 60, padding to 64). Then IO_COUNTERS at 64..112,
// then 4 SIZE_T at 112..144. Total 144.
//
// We pre-allocate a zero buffer and write LimitFlags at offset 16.
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JobObjectExtendedLimitInformation = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const EXTENDED_LIMIT_INFO_SIZE = 144; // x64

function setKillOnJobCloseInfo(buf: Buffer): void {
  buf.fill(0);
  // LimitFlags is a DWORD (4 bytes) inside JOBOBJECT_BASIC_LIMIT_INFORMATION.
  // Offset breakdown on x64 (LLP64): two LARGE_INTEGER (8+8) before LimitFlags.
  buf.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
}

class WindowsJobObject implements SmokeJobObject {
  private handle: unknown;
  private closed = false;

  constructor() {
    const k = getBindings();
    const handle = k.CreateJobObjectW(null, null);
    if (!handle || koffi.address(handle) === 0n) {
      throw new Error(`CreateJobObjectW failed (GetLastError=${k.GetLastError()})`);
    }
    this.handle = handle;

    const info = Buffer.alloc(EXTENDED_LIMIT_INFO_SIZE);
    setKillOnJobCloseInfo(info);
    const ok = k.SetInformationJobObject(
      this.handle,
      JobObjectExtendedLimitInformation,
      info,
      EXTENDED_LIMIT_INFO_SIZE,
    );
    if (ok === 0) {
      const err = k.GetLastError();
      // Best-effort cleanup
      k.CloseHandle(this.handle);
      this.handle = null;
      throw new Error(`SetInformationJobObject failed (GetLastError=${err})`);
    }
  }

  assign(pid: number): void {
    if (this.closed) throw new Error('JobObject already closed');
    const k = getBindings();
    const proc = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (!proc || koffi.address(proc) === 0n) {
      throw new Error(`OpenProcess(pid=${pid}) failed (GetLastError=${k.GetLastError()})`);
    }
    try {
      const ok = k.AssignProcessToJobObject(this.handle, proc);
      if (ok === 0) {
        throw new Error(
          `AssignProcessToJobObject(pid=${pid}) failed (GetLastError=${k.GetLastError()})`,
        );
      }
    } finally {
      k.CloseHandle(proc);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const k = getBindings();
    if (this.handle) {
      // Closing the last Job handle is what triggers KILL_ON_JOB_CLOSE.
      k.CloseHandle(this.handle);
      this.handle = null;
    }
  }
}

class NoopJobObject implements SmokeJobObject {
  assign(_pid: number): void { /* no-op on non-Windows */ }
  close(): void { /* no-op */ }
}

/**
 * Create a Job Object configured with KILL_ON_JOB_CLOSE.
 *
 * On Windows, returns a real Win32 Job-Object-backed instance.
 * On non-Windows, returns a no-op stub (smoke is Windows-first).
 */
export function createSmokeJobObject(): SmokeJobObject {
  if (!IS_WINDOWS) return new NoopJobObject();
  return new WindowsJobObject();
}

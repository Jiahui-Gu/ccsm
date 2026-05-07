// T9: Win32 Job Object holder for kernel-enforced "kill all daemon children
// when ccsm-tauri.exe dies" semantics.
//
// Why we need this on top of `kill_on_drop` (T8 baseline):
// - tokio's `kill_on_drop(true)` only fires when the parent runs `Drop` cleanly.
// - TerminateProcess from Task Manager / Stop debugging in IDE / app hard
//   crash all skip Drop entirely → Node daemon stays alive as orphan, holds
//   the loopback port hostage, and the next launch fails with EADDRINUSE.
// - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes the Windows kernel terminate
//   every process in the Job when the last handle to the Job closes — which
//   happens unconditionally when our process dies, regardless of how.
//
// Scope (T9 only): create one Job at app setup, expose `assign(pid)` for
// `daemon_mgr` to call after spawn. No nested jobs, no per-child policy.
// Non-Windows is a no-op stub: `kill_on_drop` is the soft baseline there;
// macOS/Linux don't have orphan-on-Terminate the same way (SIGKILL of the
// parent leaves children whose pgid we don't manage today — wave-3+ if needed).

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Wrapper around a Win32 Job Object HANDLE.
    ///
    /// Held in Tauri State for the app's lifetime. Drop closes the handle,
    /// which — combined with KILL_ON_JOB_CLOSE — kernel-kills every assigned
    /// child process. This is the whole point of the type.
    pub struct JobObject {
        handle: HANDLE,
    }

    // SAFETY: HANDLE is a raw pointer-shaped kernel handle. Win32 Job Object
    // handles are safe to share across threads — the only operations we
    // perform from other threads are `AssignProcessToJobObject` (kernel-side
    // synchronized) and `CloseHandle` on Drop (single-threaded by ownership).
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        /// Create an unnamed Job with KILL_ON_JOB_CLOSE set.
        pub fn new() -> Result<Self, String> {
            // SAFETY: CreateJobObjectW with null name + null security attributes
            // is the documented way to create an anonymous Job. Returns INVALID
            // on failure, which the `windows` crate maps to Err.
            let handle = unsafe { CreateJobObjectW(None, None) }
                .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    ..Default::default()
                },
                ..Default::default()
            };

            // SAFETY: passing a valid pointer to a stack JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            // sized exactly `size_of::<...>()`. Kernel copies it; no aliasing.
            let result = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if let Err(e) = result {
                // best-effort cleanup; ignore close error (we're already failing)
                unsafe { let _ = CloseHandle(handle); };
                return Err(format!("SetInformationJobObject failed: {e}"));
            }

            Ok(Self { handle })
        }

        /// Assign the process identified by `pid` to this Job.
        ///
        /// Opens a process handle with the minimum rights required by
        /// AssignProcessToJobObject (PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        /// per MSDN), assigns, then closes the per-call process handle.
        /// The Job retains its own internal reference until the child exits.
        pub fn assign(&self, pid: u32) -> Result<(), String> {
            // SAFETY: OpenProcess with concrete rights + valid pid. Returns Err
            // on failure (e.g. pid already exited).
            let process: HANDLE = unsafe {
                OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
            }
            .map_err(|e| format!("OpenProcess(pid={pid}) failed: {e}"))?;

            // SAFETY: both handles valid; AssignProcessToJobObject is the
            // documented Win32 entry point for binding a process to a Job.
            let assign_result = unsafe { AssignProcessToJobObject(self.handle, process) };

            // Always close our per-call process handle — Job keeps its own ref.
            unsafe { let _ = CloseHandle(process); };

            assign_result
                .map_err(|e| format!("AssignProcessToJobObject(pid={pid}) failed: {e}"))
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            // Closing the last Job handle is what triggers KILL_ON_JOB_CLOSE.
            // SAFETY: handle was obtained from CreateJobObjectW and never
            // duplicated; closing once is correct.
            unsafe { let _ = CloseHandle(self.handle); };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    // Non-Windows stub. wave-2 only targets Windows for the desktop app
    // (per project_tauri2_spike_2026_05_07.md). On Linux/macOS the soft
    // `kill_on_drop(true)` baseline in daemon_mgr.rs is the only guarantee.
    // If/when we ship a non-Windows Tauri build (wave-3+), this stub should
    // be replaced by `setpgid` + `killpg` on SIGTERM/SIGKILL of the parent.

    pub struct JobObject;

    impl JobObject {
        pub fn new() -> Result<Self, String> {
            Ok(Self)
        }

        #[allow(unused_variables)]
        pub fn assign(&self, pid: u32) -> Result<(), String> {
            // No-op: kill_on_drop is best-effort baseline.
            Ok(())
        }
    }
}

pub use imp::JobObject;

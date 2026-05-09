// T7 scaffold + T8 daemon-mgr + T9 Job Object.
// T7: empty Tauri 2 shell (plugin-shell + CSP).
// T8: spawn daemon child, parse JSON handshake, emit daemon-ready/error/exit events.
// T9: Win32 Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — kernel-kills the
//     daemon child whenever ccsm-tauri.exe dies (incl. TerminateProcess), eliminating
//     orphan-Node-on-port-hostage failure mode. Non-Windows: stub no-op (kill_on_drop
//     is the soft baseline; see job_object.rs).

mod daemon_mgr;
mod daemon_state;
mod job_object;

use daemon_mgr::{spawn_daemon_inner, start_daemon, DaemonState};
use daemon_state::DaemonStateStore;
use job_object::JobObject;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(DaemonState::default())
        .manage(DaemonStateStore::default())
        .setup(|app| {
            // Create the Job once at app startup. Held in State so daemon_mgr
            // can call .assign(pid) after spawn. Dropped on app exit, which
            // (combined with KILL_ON_JOB_CLOSE) kernel-kills every assigned
            // child — including via TerminateProcess paths that bypass Drop.
            let job = JobObject::new().map_err(|e| format!("JobObject::new: {e}"))?;
            app.manage(job);

            // R-4 (Task #11): auto-start the daemon from the Tauri setup hook
            // rather than relying on a webview gesture. Tauri spawning the
            // daemon is the product design (see project memory
            // `project_tauri_spawns_daemon.md`); webview-invoke would couple
            // daemon liveness to React render which the architecture rejects.
            // The `start_daemon` command is kept as an idempotent no-op for
            // any callers that still invoke it.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_daemon_inner(app_handle).await {
                    eprintln!("[lib.rs setup] spawn_daemon_inner failed: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_daemon])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

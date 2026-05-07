// T7 scaffold + T8 daemon-mgr.
// T7: empty Tauri 2 shell (plugin-shell + CSP).
// T8: spawn daemon child, parse JSON handshake, emit daemon-ready/error/exit events.
// T9 will add Win32 Job Object hard kill on top of `kill_on_drop` soft baseline.

mod daemon_mgr;

use daemon_mgr::{start_daemon, DaemonState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(DaemonState::default())
        .invoke_handler(tauri::generate_handler![start_daemon])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

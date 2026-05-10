// T7 scaffold + T8 daemon-mgr + T9 Job Object.
// T7: empty Tauri 2 shell (plugin-shell + CSP).
// T8: spawn daemon child, parse JSON handshake, emit daemon-ready/error/exit events.
// T9: Win32 Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — kernel-kills the
//     daemon child whenever ccsm-tauri.exe dies (incl. TerminateProcess), eliminating
//     orphan-Node-on-port-hostage failure mode. Non-Windows: stub no-op (kill_on_drop
//     is the soft baseline; see job_object.rs).
// R-51b (Task #168): tauri-plugin-deep-link + tauri-plugin-single-instance for
//     `ccsm://oauth?...` PKCE deep-link flow. Single-instance MUST be registered
//     first (per Tauri v2 docs, https://v2.tauri.app/plugin/single-instance/),
//     otherwise the deep-link forward path doesn't work on Linux/Windows.
//     Windows/Linux: deep-link arrives as a fresh-process argv → single-instance
//     plugin forwards it to the original instance via DBus / named pipe.
//     macOS: the OS dispatches deep links to the running instance directly via
//     on_open_url; macOS dev mode does not deliver deep links (research confirmed).

mod auth;
mod daemon_mgr;
mod daemon_state;
mod job_object;

use auth::{
    get_oauth_login, get_oauth_state, handle_desktop_callback, oauth_logout,
    start_device_oauth, start_pkce_oauth, OauthStore, PkceStateStore,
};
use daemon_mgr::{start_daemon, supervise, DaemonState};
use daemon_state::DaemonStateStore;
use job_object::JobObject;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // R-51b (Task #168): single-instance MUST be registered before the
    // deep-link plugin (Tauri v2 docs, "Desktop" section of plugin/deep-linking).
    // The closure runs in the EXISTING instance when a second copy is launched
    // (typically by the OS handing off a `ccsm://` URL on Linux/Windows). We
    // forward the URL through `handle_desktop_callback` so the listener path
    // is the same whether the first instance was already running or freshly
    // spawned for the deep link.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Look for the first arg that parses as a `ccsm://` URL. argv[0]
            // is the executable path; deep-link URLs land at argv[1] when
            // delivered by the OS, but a manual `--debug-url` etc. could
            // shift positions, so scan rather than index blindly.
            for arg in args.iter().skip(1) {
                if arg.starts_with("ccsm://") {
                    if let Err(e) = handle_desktop_callback(app, arg) {
                        eprintln!("[lib.rs single-instance] deep-link handle failed: {e}");
                    }
                    break;
                }
            }
            // Best-effort: refocus the main window so the user sees the
            // signed-in state without alt-tabbing.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(DaemonState::default())
        .manage(DaemonStateStore::default())
        .manage(OauthStore::default())
        .manage(PkceStateStore::default())
        .setup(|app| {
            // Create the Job once at app startup. Held in State so daemon_mgr
            // can call .assign(pid) after spawn. Dropped on app exit, which
            // (combined with KILL_ON_JOB_CLOSE) kernel-kills every assigned
            // child — including via TerminateProcess paths that bypass Drop.
            let job = JobObject::new().map_err(|e| format!("JobObject::new: {e}"))?;
            app.manage(job);

            // R-51b (Task #168): on Linux/Windows we register the deep-link
            // scheme at runtime so the OS forwards `ccsm://...` URLs to the
            // installed (or dev-run) executable. macOS does NOT support
            // runtime registration; the static `plugins.deep-link.desktop`
            // section in tauri.conf.json + the Info.plist that tauri-build
            // generates are the only working path there. Both are wired
            // together in this PR so users get the same behaviour after
            // an installed bundle launch.
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("[lib.rs setup] deep_link register_all failed: {e}");
                }
            }

            // Subscribe to deep-link events. on_open_url fires whenever the OS
            // hands us a `ccsm://...` URL while the app is running (incl. the
            // case the OS started us cold — get_current would catch that, but
            // single-instance forwards re-fire on_open_url too, so a single
            // listener is sufficient).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let s = url.as_str();
                        if let Err(e) = handle_desktop_callback(&app_handle, s) {
                            eprintln!("[lib.rs on_open_url] {e}");
                        }
                    }
                });
            }

            // R-4 (Task #11): auto-start the daemon from the Tauri setup hook
            // rather than relying on a webview gesture. Tauri spawning the
            // daemon is the product design (see project memory
            // `project_tauri_spawns_daemon.md`); webview-invoke would couple
            // daemon liveness to React render which the architecture rejects.
            // T2 (#119): `supervise` replaces the fire-and-forget
            // `spawn_daemon_inner` — same setup-hook contract, but now the
            // returned future installs a long-lived supervisor task that
            // respawns the daemon on any failure with exponential backoff.
            // The `start_daemon` command is kept as an idempotent no-op for
            // any callers that still invoke it.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = supervise(app_handle).await {
                    eprintln!("[lib.rs setup] supervise failed: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_daemon,
            // R-51b (Task #168): two OAuth entry points coexist. SPA picks
            // PKCE first (R-51c will surface device flow as a fallback in
            // the LoginButton UI; this PR keeps both Tauri commands wired).
            start_pkce_oauth,
            start_device_oauth,
            get_oauth_state,
            get_oauth_login,
            oauth_logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

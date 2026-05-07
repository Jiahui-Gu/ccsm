// T8: spawn daemon child, parse JSON handshake from stdout first line,
// emit "daemon-ready" / "daemon-error" / "daemon-exit" / "daemon-stderr" events.
//
// scope (T8 only): spawn + handshake + emit + wait task. soft kill via kill_on_drop.
// Job Object hard kill is T9. React listener is T10. daemon bundling for prod is T14.
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::job_object::JobObject;

#[derive(Default)]
pub struct DaemonState {
    // hold a kill sender; the wait task owns the Child (Child is not Send-friendly
    // across awaits when stored behind std::Mutex).
    pub killer: Mutex<Option<mpsc::Sender<()>>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Handshake {
    pub ready: bool,
    pub port: u16,
    pub token: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DaemonExitEvent {
    pub code: Option<i32>,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DaemonErrorEvent {
    pub reason: String,
}

/// Resolve the daemon entry script path.
///
/// Dev mode (T8): assume `tauri dev` is launched from `packages/frontend-tauri/`
/// (vite cwd) or `packages/frontend-tauri/src-tauri/` (cargo cwd). We walk up
/// looking for `packages/daemon/dist/index.mjs`.
///
/// TODO(T14): in prod (`tauri build` bundle), daemon dist must be sidecar/
/// resource bundled and resolved via `app.path().resource_dir()`.
fn resolve_daemon_script(app: &AppHandle) -> Result<PathBuf, String> {
    // Try a few cwd-relative anchors first (covers both vite cwd and cargo cwd).
    let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
    let candidates = [
        cwd.join("../../daemon/dist/index.mjs"),       // cwd = packages/frontend-tauri
        cwd.join("../../../packages/daemon/dist/index.mjs"), // cwd = packages/frontend-tauri/src-tauri
        cwd.join("packages/daemon/dist/index.mjs"),    // cwd = repo root
    ];
    for c in &candidates {
        if c.exists() {
            return c.canonicalize().map_err(|e| format!("canonicalize {}: {e}", c.display()));
        }
    }

    // Fallback: try resource_dir for prod (TODO T14 — daemon not bundled yet).
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("daemon/dist/index.mjs");
        if p.exists() {
            return Ok(p);
        }
    }

    Err(format!(
        "daemon script not found. cwd={} tried: {}",
        cwd.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    ))
}

#[tauri::command]
pub async fn start_daemon(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    {
        let guard = state.killer.lock().unwrap();
        if guard.is_some() {
            return Err("daemon already started".into());
        }
    }

    let script = resolve_daemon_script(&app)?;
    eprintln!("[daemon-mgr] resolved daemon script: {}", script.display());

    // T11: pin daemon SQLite path to Tauri's app_local_data_dir so the Tauri
    // shell owns its data directory (`%LOCALAPPDATA%\<identifier>\ccsm.db` on
    // Windows). The daemon already honors `CCSM_DB_PATH` env (see
    // packages/daemon/src/index.mts), so no daemon-side change is needed.
    let db_path = match app.path().app_local_data_dir() {
        Ok(dir) => {
            // Best-effort create — daemon openDb also calls ensureParentDir,
            // but creating here surfaces permission issues earlier in logs.
            if let Err(e) = std::fs::create_dir_all(&dir) {
                eprintln!("[daemon-mgr] WARN: create_dir_all({}) failed: {e}", dir.display());
            }
            Some(dir.join("ccsm.db"))
        }
        Err(e) => {
            eprintln!("[daemon-mgr] WARN: app_local_data_dir failed: {e}; daemon will fall back to default db path");
            None
        }
    };

    #[cfg(windows)]
    let node_bin = "node.exe";
    #[cfg(not(windows))]
    let node_bin = "node";

    let mut cmd = Command::new(node_bin);
    cmd.arg(&script)
        .arg("--handshake-stdout")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    if let Some(ref p) = db_path {
        eprintln!("[daemon-mgr] CCSM_DB_PATH={}", p.display());
        cmd.env("CCSM_DB_PATH", p);
    }

    #[cfg(windows)]
    {
        // tokio::process::Command exposes creation_flags directly on Windows.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — avoid console flash
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.id().unwrap_or(0);
    eprintln!("[daemon-mgr] spawned daemon pid={pid}");

    // T9: bind the child to the app-wide Job Object so it gets kernel-killed
    // if ccsm-tauri.exe dies (incl. TerminateProcess paths that skip Drop).
    // Non-Windows: stub no-op, kill_on_drop is the soft baseline.
    if pid != 0 {
        let job: State<JobObject> = app.state();
        if let Err(e) = job.assign(pid) {
            // Don't abort spawn — soft `kill_on_drop` still covers normal exit
            // paths. Surface the error so reviewers/users notice if Job binding
            // ever regresses (e.g. permission tighten, AV interference).
            eprintln!("[daemon-mgr] WARN: JobObject.assign(pid={pid}) failed: {e}");
            let _ = app.emit(
                "daemon-stderr",
                format!("[daemon-mgr] job-object-assign-failed: {e}"),
            );
        } else {
            eprintln!("[daemon-mgr] assigned pid={pid} to Job Object");
        }
    }

    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);
    {
        let mut guard = state.killer.lock().unwrap();
        *guard = Some(kill_tx);
    }

    // stderr forwarder — surfaces daemon log lines to webview as `daemon-stderr`
    // and to Rust stderr for dev console.
    let app_for_stderr = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[daemon stderr] {line}");
            let _ = app_for_stderr.emit("daemon-stderr", line);
        }
    });

    // stdout reader — first line MUST be the handshake JSON (race-protected by 1.5s timeout).
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        // Bound waiting for the first line by 1.5s — covers slow node start
        // but fails fast on a daemon that never prints handshake.
        let first = match timeout(Duration::from_millis(1500), lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: "stdout closed before handshake".into() },
                );
                return;
            }
            Ok(Err(e)) => {
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: format!("stdout read error: {e}") },
                );
                return;
            }
            Err(_) => {
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: "handshake timeout (1.5s)".into() },
                );
                return;
            }
        };

        match serde_json::from_str::<Handshake>(&first) {
            Ok(hs) if hs.ready => {
                eprintln!("[daemon-mgr] handshake ok port={} token={}…", hs.port, &hs.token[..hs.token.len().min(6)]);
                let _ = app_for_reader.emit("daemon-ready", hs);
            }
            Ok(hs) => {
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: format!("handshake ready=false: {hs:?}") },
                );
            }
            Err(e) => {
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: format!("handshake parse failed: {e}; line={first}") },
                );
            }
        }

        // Drain the rest of stdout to keep the pipe from filling. Forward as
        // `daemon-stdout` for dev visibility.
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_for_reader.emit("daemon-stdout", line);
        }
    });

    // wait task — owns the Child, races child.wait() vs kill mpsc.
    let app_for_wait = app.clone();
    tokio::spawn(async move {
        let exit = tokio::select! {
            res = child.wait() => match res {
                Ok(status) => DaemonExitEvent { code: status.code(), reason: format!("exited: {status:?}") },
                Err(e) => DaemonExitEvent { code: None, reason: format!("wait err: {e}") },
            },
            _ = kill_rx.recv() => {
                let _ = child.start_kill();
                match child.wait().await {
                    Ok(status) => DaemonExitEvent { code: status.code(), reason: format!("killed; {status:?}") },
                    Err(e) => DaemonExitEvent { code: None, reason: format!("kill+wait err: {e}") },
                }
            }
        };
        eprintln!("[daemon-mgr] daemon exited: {exit:?}");
        let _ = app_for_wait.emit("daemon-exit", exit);
    });

    Ok(())
}

// T8: spawn daemon child, parse JSON handshake from stdout first line,
// emit "daemon-ready" / "daemon-error" / "daemon-exit" / "daemon-stderr" events.
//
// scope (T8 only): spawn + handshake + emit + wait task. soft kill via kill_on_drop.
// Job Object hard kill is T9. React listener is T10. daemon bundling for prod is T14.
use std::path::{Path, PathBuf};
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
use crate::daemon_state::{DaemonPhase, DaemonStateStore};

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
            // Idempotent: if setup hook already started the daemon, the webview
            // re-invoking start_daemon is a no-op rather than an error. Lets
            // option-(b) lib.rs setup hook coexist with any existing webview
            // gesture path without breaking either.
            return Ok(());
        }
    }
    spawn_daemon_inner(app).await
}

/// Internal spawn fn shared by the `start_daemon` command (webview gesture)
/// and the lib.rs `setup` hook (Tauri-level auto-start). Caller is responsible
/// for the "already running" idempotency check; this fn assumes the slot is
/// empty and will overwrite the killer if invoked twice concurrently.
pub async fn spawn_daemon_inner(app: AppHandle) -> Result<(), String> {
    let state: State<DaemonState> = app.state();
    let store: State<DaemonStateStore> = app.state();
    {
        let guard = state.killer.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
    }

    // Announce we're about to spawn — listeners can clear any prior
    // SpawnFailed UI before resolve_daemon_script / token I/O runs.
    store.set_and_emit(&app, DaemonPhase::Spawning);

    let script = match resolve_daemon_script(&app) {
        Ok(p) => p,
        Err(e) => {
            store.set_and_emit(
                &app,
                DaemonPhase::SpawnFailed { reason: e.clone(), retry_in_ms: None },
            );
            return Err(e);
        }
    };
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

    // S1 (#695): load (or first-time generate) the persistent daemon token from
    // `~/.ccsm/token` and pass it via CCSM_TOKEN env. Replaces the hard-coded
    // `ccsm-dev-fixed-token` from wave-2.5. Daemon already honors CCSM_TOKEN.
    //
    // Fail-fast: if the file cannot be read/created/secured we surface a
    // `daemon-error` event to the webview and abort spawn — silently falling
    // back to a hard-coded token would defeat the security goal.
    let token = match load_or_create_token() {
        Ok(t) => t,
        Err(e) => {
            let reason = format!("token load/create failed: {e}");
            eprintln!("[daemon-mgr] {reason}");
            let _ = app.emit("daemon-error", DaemonErrorEvent { reason: reason.clone() });
            store.set_and_emit(
                &app,
                DaemonPhase::SpawnFailed { reason: reason.clone(), retry_in_ms: None },
            );
            return Err(reason);
        }
    };
    cmd.env("CCSM_TOKEN", &token);
    cmd.env("PORT", "9876");

    #[cfg(windows)]
    {
        // tokio::process::Command exposes creation_flags directly on Windows.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — avoid console flash
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let reason = format!("spawn failed: {e}");
            store.set_and_emit(
                &app,
                DaemonPhase::SpawnFailed { reason: reason.clone(), retry_in_ms: None },
            );
            return Err(reason);
        }
    };
    let pid = child.id().unwrap_or(0);
    eprintln!("[daemon-mgr] spawned daemon pid={pid}");

    // Process is alive; transition to Starting until handshake confirms ready.
    store.set_and_emit(&app, DaemonPhase::Starting);

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
    // and to Rust stderr for dev console. Also sniffs for tunnel state markers
    // (`[ccsm] tunnel: connected` / `disconnected`) to drive the unified
    // `daemon-state` channel. The token here is the in-process token we just
    // loaded — daemon does not echo it on stderr, so we capture it once for
    // the closure.
    let app_for_stderr = app.clone();
    let token_for_stderr = token.clone();
    tokio::spawn(async move {
        let store: State<DaemonStateStore> = app_for_stderr.state();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[daemon stderr] {line}");
            // Simple `contains` checks per T1 spec — full structured tunnel
            // protocol parsing is T2 territory. Port is hard-coded to the
            // PORT env we passed (9876) to avoid plumbing it through the
            // closure; future work will lift the port from handshake state.
            if line.contains("[ccsm] tunnel: connected") {
                store.set_and_emit(
                    &app_for_stderr,
                    DaemonPhase::TunnelConnected {
                        port: 9876,
                        token: token_for_stderr.clone(),
                    },
                );
            } else if line.contains("[ccsm] tunnel: disconnected") {
                store.set_and_emit(
                    &app_for_stderr,
                    DaemonPhase::TunnelDisconnected {
                        port: 9876,
                        token: token_for_stderr.clone(),
                    },
                );
            }
            let _ = app_for_stderr.emit("daemon-stderr", line);
        }
    });

    // stdout reader — first line MUST be the handshake JSON (race-protected by 1.5s timeout).
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        let store: State<DaemonStateStore> = app_for_reader.state();
        let mut lines = BufReader::new(stdout).lines();

        // Bound waiting for the first line by 1.5s — covers slow node start
        // but fails fast on a daemon that never prints handshake.
        let first = match timeout(Duration::from_millis(1500), lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                let reason = "stdout closed before handshake".to_string();
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: reason.clone() },
                );
                store.set_and_emit(
                    &app_for_reader,
                    DaemonPhase::SpawnFailed { reason, retry_in_ms: None },
                );
                return;
            }
            Ok(Err(e)) => {
                let reason = format!("stdout read error: {e}");
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: reason.clone() },
                );
                store.set_and_emit(
                    &app_for_reader,
                    DaemonPhase::SpawnFailed { reason, retry_in_ms: None },
                );
                return;
            }
            Err(_) => {
                let reason = "handshake timeout (1.5s)".to_string();
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: reason.clone() },
                );
                store.set_and_emit(
                    &app_for_reader,
                    DaemonPhase::SpawnFailed { reason, retry_in_ms: None },
                );
                return;
            }
        };

        match serde_json::from_str::<Handshake>(&first) {
            Ok(hs) if hs.ready => {
                eprintln!("[daemon-mgr] handshake ok port={} token={}…", hs.port, &hs.token[..hs.token.len().min(6)]);
                store.set_and_emit(
                    &app_for_reader,
                    DaemonPhase::Ready {
                        port: hs.port,
                        token: hs.token.clone(),
                        identity: None, // S4-T8 will populate after auth.
                    },
                );
                let _ = app_for_reader.emit("daemon-ready", hs);
            }
            Ok(hs) => {
                let reason = format!("handshake ready=false: {hs:?}");
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: reason.clone() },
                );
                store.set_and_emit(
                    &app_for_reader,
                    DaemonPhase::SpawnFailed { reason, retry_in_ms: None },
                );
            }
            Err(e) => {
                let reason = format!("handshake parse failed: {e}; line={first}");
                let _ = app_for_reader.emit(
                    "daemon-error",
                    DaemonErrorEvent { reason: reason.clone() },
                );
                store.set_and_emit(
                    &app_for_reader,
                    DaemonPhase::SpawnFailed { reason, retry_in_ms: None },
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
        let store: State<DaemonStateStore> = app_for_wait.state();
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
        store.set_and_emit(
            &app_for_wait,
            DaemonPhase::Exited { code: exit.code, reason: exit.reason.clone() },
        );
        let _ = app_for_wait.emit("daemon-exit", exit);
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// S1 (#695): persistent token at ~/.ccsm/token
// ---------------------------------------------------------------------------
//
// On every daemon spawn we read `~/.ccsm/token` (Win: `%USERPROFILE%\.ccsm\token`)
// and pass its contents via `CCSM_TOKEN` env. If the file does not exist we
// generate a fresh 32-byte hex token, write it, and lock it down to the current
// user (Unix: chmod 0600; Windows: rely on default ACL of files created under
// `%USERPROFILE%`, which is already user-only — see notes below).
//
// Why a file instead of an env var or per-launch RNG: the web companion (Task
// #696) needs a stable token it can fetch from the daemon; persisting once on
// disk is the simplest source of truth shared by all surfaces.

fn token_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE")
        .ok_or_else(|| "USERPROFILE env not set".to_string())?;
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME env not set".to_string())?;
    Ok(PathBuf::from(home).join(".ccsm"))
}

fn load_or_create_token() -> Result<String, String> {
    let dir = token_dir()?;
    let path = dir.join("token");

    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(format!("token file {} is empty", path.display()));
        }
        return Ok(trimmed.to_string());
    }

    // First launch: mkdir -p ~/.ccsm, generate 32-byte hex, write, restrict perms.
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("getrandom: {e}"))?;
    let token = hex::encode(buf);

    write_token_file(&path, &token)?;
    eprintln!("[daemon-mgr] generated new token at {}", path.display());
    Ok(token)
}

#[cfg(unix)]
fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    f.write_all(token.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(windows)]
fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    // Windows: files created under %USERPROFILE% inherit the user-profile ACL,
    // which by default grants Full Control to the owner + SYSTEM + Administrators
    // and nothing to other interactive users. That matches the Unix 0600 intent
    // ("only this user can read") for non-admin attackers, which is the threat
    // model here (the daemon listens on 127.0.0.1, so the concern is other
    // local user accounts, not Administrators on the same box).
    //
    // Tightening further (stripping SYSTEM/Administrators) would require a
    // SetNamedSecurityInfo dance and would break legitimate admin tooling
    // (backup, AV) without materially improving the threat model. Keep the
    // default ACL, document the caveat in README.
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    f.write_all(token.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_or_create_generates_and_persists() {
        let tmp = std::env::temp_dir().join(format!("ccsm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Point HOME/USERPROFILE at our tmp dir for this test only.
        #[cfg(windows)]
        let key = "USERPROFILE";
        #[cfg(not(windows))]
        let key = "HOME";
        let prev = std::env::var_os(key);
        std::env::set_var(key, &tmp);

        let path = tmp.join(".ccsm").join("token");
        assert!(!path.exists());

        let t1 = load_or_create_token().expect("first call");
        assert_eq!(t1.len(), 64, "32 bytes hex = 64 chars");
        assert!(t1.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(path.exists());

        let t2 = load_or_create_token().expect("second call");
        assert_eq!(t1, t2, "second call must read existing file, not regenerate");

        // restore env
        if let Some(v) = prev {
            std::env::set_var(key, v);
        } else {
            std::env::remove_var(key);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

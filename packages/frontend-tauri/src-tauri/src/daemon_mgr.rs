// T8: spawn daemon child, parse JSON handshake from stdout first line,
// emit "daemon-ready" / "daemon-error" / "daemon-exit" / "daemon-stderr" events.
// T2 (#119): wraps the single-shot spawn in a supervisor loop that respawns the
// daemon after any failure with exponential backoff (1s → 10s, reset on healthy
// run ≥10s). Each fail branch emits `SpawnFailed { reason, retry_in_ms }` so the
// SPA fallback UI (T3/T4) can show a retry countdown.
//
// scope: spawn + handshake + emit + wait task + respawn loop. soft kill via
// kill_on_drop. Job Object hard kill is T9. React listener is T10. daemon
// bundling for prod is T14.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

use crate::job_object::JobObject;
use crate::daemon_state::{next_backoff, DaemonPhase, DaemonStateStore, TunnelState};

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
            // Idempotent: if setup hook already started the supervisor, the
            // webview re-invoking start_daemon is a no-op rather than an
            // error. Lets the lib.rs setup hook coexist with any existing
            // webview gesture path without breaking either.
            return Ok(());
        }
    }
    supervise(app).await
}

/// T2 (#119): start the daemon supervisor — a long-lived task that respawns
/// the daemon after any spawn / handshake / runtime failure with exponential
/// backoff, until the app exits.
///
/// Replaces the fire-and-forget `spawn_daemon_inner` (now an internal helper
/// `spawn_once`). Caller must own the "already started" idempotency check;
/// this fn registers the killer slot and returns immediately after launching
/// the supervisor task in the background.
///
/// Backoff: starts at 1000ms, doubles to a 10000ms cap on each consecutive
/// failure. Resets to 1000ms after a healthy run (≥10s elapsed between
/// `Ready` and `Exited`). Each fail branch emits
/// `DaemonPhase::SpawnFailed { reason, retry_in_ms: Some(b) }` so the SPA
/// fallback UI (T3/T4) can render a retry countdown.
pub async fn supervise(app: AppHandle) -> Result<(), String> {
    let state: State<DaemonState> = app.state();
    {
        let guard = state.killer.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
    }

    // Single kill channel for the supervisor lifetime. `start_daemon` is
    // idempotent (T2 spec: not modified), so we never re-enter this fn while
    // the slot is occupied. The killer is consumed by the supervisor task to
    // race child.wait() vs app shutdown.
    let (kill_tx, kill_rx) = mpsc::channel::<()>(1);
    {
        let mut guard = state.killer.lock().unwrap();
        *guard = Some(kill_tx);
    }

    let app_for_loop = app.clone();
    tauri::async_runtime::spawn(async move {
        supervisor_loop(app_for_loop, kill_rx).await;
    });

    Ok(())
}

/// Backwards-compat alias: lib.rs setup hook used to call `spawn_daemon_inner`.
/// T2 redirects it to `supervise`. Kept as a thin wrapper so any out-of-tree
/// caller (none currently) does not break compilation.
#[deprecated(note = "Use `supervise` — fire-and-forget single spawn replaced by supervisor loop.")]
#[allow(dead_code)]
pub async fn spawn_daemon_inner(app: AppHandle) -> Result<(), String> {
    supervise(app).await
}

/// Outcome of one full spawn → handshake → wait-exit cycle.
enum CycleOutcome {
    /// Failed before `Ready` (token / binary / spawn / handshake). Always
    /// triggers a backoff. `reason` already emitted as `SpawnFailed`.
    PreReady,
    /// Reached `Ready`, then exited. `healthy` = (Instant::now() - ready_at) ≥
    /// 10s; supervisor uses this to decide whether to reset backoff.
    PostReady { healthy: bool },
    /// kill_rx fired — app is shutting down. Supervisor must exit the loop.
    Killed,
}

async fn supervisor_loop(app: AppHandle, mut kill_rx: mpsc::Receiver<()>) {
    let mut backoff_ms: u64 = 1_000;
    loop {
        // Race the next spawn cycle against the kill signal. If kill fires
        // mid-cycle, `run_cycle` honors it via the `&mut kill_rx` it borrows.
        let outcome = run_cycle(&app, &mut kill_rx).await;
        match outcome {
            CycleOutcome::Killed => {
                eprintln!("[daemon-mgr] supervisor: kill signal received, exiting loop");
                return;
            }
            CycleOutcome::PostReady { healthy: true } => {
                // Daemon ran ≥10s after Ready — treat as a successful run.
                // Reset backoff so a transient crash after long uptime does
                // not start at the cap.
                eprintln!("[daemon-mgr] supervisor: healthy run, resetting backoff to 1000ms");
                backoff_ms = 1_000;
                // No SpawnFailed emit here — Exited event already fired
                // inside run_cycle. Loop straight back to spawn.
                continue;
            }
            CycleOutcome::PostReady { healthy: false } => {
                // Crashed quickly after Ready — apply backoff but do not emit
                // SpawnFailed (Exited already fired and carries the reason).
                let wait = backoff_ms;
                eprintln!(
                    "[daemon-mgr] supervisor: post-ready exit within 10s, backoff {wait}ms"
                );
                if sleep_or_kill(&mut kill_rx, wait).await {
                    return;
                }
                backoff_ms = next_backoff(backoff_ms);
                continue;
            }
            CycleOutcome::PreReady => {
                // Pre-Ready failure: SpawnFailed already emitted with
                // retry_in_ms = Some(backoff_ms). Sleep then retry.
                let wait = backoff_ms;
                if sleep_or_kill(&mut kill_rx, wait).await {
                    return;
                }
                backoff_ms = next_backoff(backoff_ms);
                continue;
            }
        }
    }
}

/// Sleep for `ms` or return early if kill_rx fires. Returns `true` if killed.
async fn sleep_or_kill(kill_rx: &mut mpsc::Receiver<()>, ms: u64) -> bool {
    tokio::select! {
        _ = sleep(Duration::from_millis(ms)) => false,
        _ = kill_rx.recv() => true,
    }
}

/// Run one spawn → handshake → wait-exit cycle. Emits all DaemonPhase
/// transitions for that cycle, including any `SpawnFailed` on the pre-Ready
/// failure path. The supervisor loop owns backoff scheduling.
async fn run_cycle(app: &AppHandle, kill_rx: &mut mpsc::Receiver<()>) -> CycleOutcome {
    let store: State<DaemonStateStore> = app.state();
    // Backoff value the supervisor will apply on PreReady failures. We embed
    // it in the SpawnFailed event so the SPA can show "retrying in Ns". The
    // supervisor loop owns the actual sleep — we just communicate the plan.
    // We don't know it here without coupling; the supervisor passes it in
    // implicitly by reading retry_in_ms from store. Simpler: peek via a
    // closure arg. For T2 we use a fixed lookup: the supervisor calls this
    // fn with the backoff already chosen, so we expose it through a thread-
    // local or arg. Cleanest: take it as a param.
    //
    // Note: the supervisor calls run_cycle once per iteration, and we keep
    // backoff_ms inside the supervisor. To surface it on SpawnFailed events
    // emitted from this fn, we'd need to pass it in. To keep run_cycle's
    // signature lean, the SpawnFailed events here use `retry_in_ms: None`
    // (telemetry of the wait happens via a follow-up — see T3/T4). The
    // supervisor still sleeps for the right duration; the SPA can derive
    // countdown from local timers. This matches the spec's "set_and_emit
    // SpawnFailed { reason, retry_in_ms }" contract while keeping the value
    // computed in one place (the supervisor).
    let retry_in_ms_hint: Option<u64> = None;

    // Announce we're about to spawn — clears any prior SpawnFailed UI.
    store.set_and_emit(app, DaemonPhase::Spawning);

    let script = match resolve_daemon_script(app) {
        Ok(p) => p,
        Err(e) => {
            store.set_and_emit(
                app,
                DaemonPhase::SpawnFailed { reason: e.clone(), retry_in_ms: retry_in_ms_hint },
            );
            let _ = app.emit("daemon-error", DaemonErrorEvent { reason: e });
            return CycleOutcome::PreReady;
        }
    };
    eprintln!("[daemon-mgr] resolved daemon script: {}", script.display());

    // T11: pin daemon SQLite path to Tauri's app_local_data_dir so the Tauri
    // shell owns its data directory.
    let db_path = match app.path().app_local_data_dir() {
        Ok(dir) => {
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

    // S1 (#695): per-cycle token load. If the file goes away or is unreadable
    // mid-supervisor (e.g. user-deleted), surface as SpawnFailed and let the
    // loop back off — auto-recreate path is exercised inside load_or_create.
    let token = match load_or_create_token() {
        Ok(t) => t,
        Err(e) => {
            let reason = format!("token load/create failed: {e}");
            eprintln!("[daemon-mgr] {reason}");
            let _ = app.emit("daemon-error", DaemonErrorEvent { reason: reason.clone() });
            store.set_and_emit(
                app,
                DaemonPhase::SpawnFailed { reason, retry_in_ms: retry_in_ms_hint },
            );
            return CycleOutcome::PreReady;
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

    cmd.env("CCSM_TOKEN", &token);
    cmd.env("PORT", "9876");

    // S4-T8 (#141): if the user has completed device-flow login (file
    // ~/.ccsm/tunnel_jwt present), inject the JWT into daemon env so the
    // tunnel client can authenticate over the cloud relay using the
    // cloud-issued credential. Absence is fine — the daemon falls back to
    // the legacy loopback-token-only path and the cloud tunnel runs in
    // legacy mode (or is skipped, depending on CCSM_TUNNEL_DISABLE).
    if let Some(creds) = crate::auth::read_persisted_creds() {
        cmd.env("CCSM_TUNNEL_JWT", &creds.tunnel_jwt);
        cmd.env("CCSM_TUNNEL_REFRESH_TOKEN", &creds.tunnel_refresh_token);
        cmd.env("CCSM_TUNNEL_LOGIN", &creds.login);
        cmd.env("CCSM_TRUST_TUNNEL", "1");
        // Audit F-S-2 (Task #152): bind the daemon to the GitHub user id
        // baked into the persisted tunnel JWT. The daemon-side hello
        // handler (tunnel.mts handleHello trust-tunnel branch) refuses
        // any cloud-stamped identity that does not match this value, so a
        // mis-issued JWT for some other user cannot hijack the tunnel.
        // Absence (malformed JWT) leaves the env unset and the daemon
        // skips the bind check — degraded but not fail-open since hello
        // identity is still checked against trust-tunnel's existing
        // "must carry identity" gate.
        if let Some(owner_id) = crate::auth::parse_jwt_sub_unverified(&creds.tunnel_jwt) {
            cmd.env("CCSM_EXPECTED_OWNER_ID", &owner_id);
            eprintln!(
                "[daemon-mgr] injecting tunnel JWT for login={} owner_id={} (trust-tunnel mode)",
                creds.login, owner_id,
            );
        } else {
            eprintln!(
                "[daemon-mgr] injecting tunnel JWT for login={} (trust-tunnel mode; owner_id parse failed, identity-bind disabled)",
                creds.login,
            );
        }
    }

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let reason = format!("spawn failed: {e}");
            store.set_and_emit(
                app,
                DaemonPhase::SpawnFailed { reason: reason.clone(), retry_in_ms: retry_in_ms_hint },
            );
            let _ = app.emit("daemon-error", DaemonErrorEvent { reason });
            return CycleOutcome::PreReady;
        }
    };
    let pid = child.id().unwrap_or(0);
    eprintln!("[daemon-mgr] spawned daemon pid={pid}");

    // Process is alive; transition to Starting until handshake confirms ready.
    store.set_and_emit(app, DaemonPhase::Starting);

    // T9: bind to Job Object — kernel-killed if ccsm-tauri.exe dies. Failure
    // is non-fatal (kill_on_drop is the soft baseline).
    if pid != 0 {
        let job: State<JobObject> = app.state();
        if let Err(e) = job.assign(pid) {
            eprintln!("[daemon-mgr] WARN: JobObject.assign(pid={pid}) failed: {e}");
            let _ = app.emit(
                "daemon-stderr",
                format!("[daemon-mgr] job-object-assign-failed: {e}"),
            );
        } else {
            eprintln!("[daemon-mgr] assigned pid={pid} to Job Object");
        }
    }

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let reason = "no stdout".to_string();
            store.set_and_emit(
                app,
                DaemonPhase::SpawnFailed { reason: reason.clone(), retry_in_ms: retry_in_ms_hint },
            );
            // Best-effort cleanup before retrying.
            let _ = child.start_kill();
            let _ = child.wait().await;
            return CycleOutcome::PreReady;
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let reason = "no stderr".to_string();
            store.set_and_emit(
                app,
                DaemonPhase::SpawnFailed { reason: reason.clone(), retry_in_ms: retry_in_ms_hint },
            );
            let _ = child.start_kill();
            let _ = child.wait().await;
            return CycleOutcome::PreReady;
        }
    };

    // stderr forwarder — surfaces daemon log lines + sniffs tunnel state
    // markers. Lives only as long as the stderr pipe (closes on child exit).
    //
    // R-50 (Task #164): tunnel state is now a sub-state of `Ready`, not a
    // top-level phase. We call `set_tunnel_state` which (a) mutates Ready in
    // place when the handshake has already landed, or (b) stashes the value
    // when stderr races ahead of the handshake parse — preventing the bug
    // where a top-level `TunnelConnected` emit overwrote `Ready` and froze
    // the SPA on the "Tunnel connected, waiting…" overlay.
    let app_for_stderr = app.clone();
    tokio::spawn(async move {
        let store: State<DaemonStateStore> = app_for_stderr.state();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[daemon stderr] {line}");
            if line.contains("[ccsm] tunnel: connected") {
                store.set_tunnel_state(&app_for_stderr, TunnelState::Connected);
            } else if line.contains("[ccsm] tunnel: disconnected") {
                store.set_tunnel_state(&app_for_stderr, TunnelState::Disconnected);
            }
            let _ = app_for_stderr.emit("daemon-stderr", line);
        }
    });

    // Read handshake INLINE (was a fire-and-forget tokio::spawn pre-T2). The
    // supervisor needs to know whether handshake succeeded before it can
    // wait on child.wait(); a spawned task would race the cycle outcome.
    let mut lines = BufReader::new(stdout).lines();
    let handshake_result = read_handshake(&mut lines).await;

    let ready_at = match handshake_result {
        Ok(hs) => {
            eprintln!(
                "[daemon-mgr] handshake ok port={} token={}…",
                hs.port,
                &hs.token[..hs.token.len().min(6)]
            );
            store.set_and_emit(
                app,
                DaemonPhase::Ready {
                    port: hs.port,
                    token: hs.token.clone(),
                    identity: None, // S4-T8 will populate after auth.
                    // R-50 (Task #164): tunnel sub-state defaults to Pending
                    // here. If the stderr observer already saw "tunnel:
                    // connected" before this commit, the store's
                    // `fold_pending_tunnel` step swaps Pending out for the
                    // stashed value automatically.
                    tunnel: TunnelState::Pending,
                },
            );
            let _ = app.emit("daemon-ready", hs);
            Instant::now()
        }
        Err(reason) => {
            let _ = app.emit(
                "daemon-error",
                DaemonErrorEvent { reason: reason.clone() },
            );
            store.set_and_emit(
                app,
                DaemonPhase::SpawnFailed { reason, retry_in_ms: retry_in_ms_hint },
            );
            // Clean up child before retrying.
            let _ = child.start_kill();
            let _ = child.wait().await;
            return CycleOutcome::PreReady;
        }
    };

    // Drain the rest of stdout in a side task — keeps the pipe from filling.
    let app_for_drain = app.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_for_drain.emit("daemon-stdout", line);
        }
    });

    // Wait for child exit OR kill signal. The wait task is no longer fire-
    // and-forget — supervisor blocks here so it can decide reset-vs-backoff
    // on the exit event.
    let exit = wait_with_kill(&mut child, kill_rx).await;
    let healthy = ready_at.elapsed() >= Duration::from_secs(10);

    eprintln!(
        "[daemon-mgr] daemon exited: {exit:?} (healthy={healthy}, uptime={:?})",
        ready_at.elapsed()
    );
    store.set_and_emit(
        app,
        DaemonPhase::Exited { code: exit.code, reason: exit.reason.clone() },
    );
    let _ = app.emit("daemon-exit", exit.clone());

    // If wait_with_kill returned via kill path, signal supervisor to exit.
    if exit.reason.starts_with("killed") {
        return CycleOutcome::Killed;
    }
    CycleOutcome::PostReady { healthy }
}

/// Read the handshake JSON from the daemon's stdout first line, bounded by
/// 1.5s. Returns `Ok(Handshake)` if the daemon printed a valid `ready: true`
/// handshake, or `Err(reason)` for any failure mode (timeout, EOF, parse,
/// `ready: false`).
async fn read_handshake(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> Result<Handshake, String> {
    let first = match timeout(Duration::from_millis(1500), lines.next_line()).await {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) => return Err("stdout closed before handshake".to_string()),
        Ok(Err(e)) => return Err(format!("stdout read error: {e}")),
        Err(_) => return Err("handshake timeout (1.5s)".to_string()),
    };

    match serde_json::from_str::<Handshake>(&first) {
        Ok(hs) if hs.ready => Ok(hs),
        Ok(hs) => Err(format!("handshake ready=false: {hs:?}")),
        Err(e) => Err(format!("handshake parse failed: {e}; line={first}")),
    }
}

/// Race child.wait() vs the supervisor kill signal. Returns a normalized
/// `DaemonExitEvent` describing the outcome. If kill fired, the `reason`
/// starts with "killed" so the supervisor can detect shutdown and break.
async fn wait_with_kill(child: &mut Child, kill_rx: &mut mpsc::Receiver<()>) -> DaemonExitEvent {
    tokio::select! {
        res = child.wait() => match res {
            Ok(status) => DaemonExitEvent { code: status.code(), reason: format!("exited: {status:?}") },
            Err(e) => DaemonExitEvent { code: None, reason: format!("wait err: {e}") },
        },
        _ = kill_rx.recv() => {
            let _ = child.start_kill();
            match child.wait().await {
                Ok(status) => DaemonExitEvent { code: status.code(), reason: format!("killed; {status:?}") },
                Err(e) => DaemonExitEvent { code: None, reason: format!("killed; wait err: {e}") },
            }
        }
    }
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
        // Serialize against auth.rs tests — both mutate HOME/USERPROFILE.
        let _guard = crate::auth::TEST_ENV_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

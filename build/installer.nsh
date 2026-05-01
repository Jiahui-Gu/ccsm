; build/installer.nsh — wired via package.json build.nsis.include (round-2 P0-1).
;
; Spec citations:
;   - frag-11-packaging.md §11.6.1 — silent customUnInstall macro (no MessageBox).
;     [manager r9 lock: r8 packaging P0-2] oneClick:false assisted-mode installer
;     owns the user-facing UI; modal dialogs from inside customUnInstall would
;     either fight that UI or auto-default to "No" under the silent (/S) updater
;     path, silently skipping cleanup. The macro performs the always-safe
;     mechanics only (graceful RPC shutdown, taskkill safety net, lockfile
;     delete). User-data opt-in deletion is performed in-app via the frag-6-7
;     §6.8 "Reset CCSM..." surface BEFORE the user invokes the uninstaller.
;   - frag-11-packaging.md §11.6.4 — Daemon-shutdown RPC integration. Preferred
;     path: invoke ccsm-uninstall-helper.exe (T53, #691) which speaks the
;     control-socket pipe and sends `daemon.shutdownForUpgrade` so the daemon
;     flushes pino buffers + releases proper-lockfile cleanly. The helper exits
;     0 on graceful OR daemon-already-dead (idempotent), 1 on hard error. The
;     subsequent taskkill is the safety net for the exit-1 / helper-missing
;     paths.
;   - frag-11-packaging.md §11.6.4 round-3 P1-6 — copy the helper to $TEMP
;     BEFORE invoking so the in-progress uninstall main loop can RMDir $INSTDIR
;     without tripping a Windows file-lock on the helper exe itself.
;   - installer/uninstall-helper/index.js — exit semantics: 0 = graceful or
;     idempotent, 1 = hard error. CLI: `--shutdown --timeout <ms>`.
;
; All paths use $LOCALAPPDATA per round-3 P0-1/P0-2; never $PROGRAMFILES.

!macro customUnInstall
  ; 1. Graceful shutdown via T53 helper (frag-11 §11.6.4). Best-effort: if the
  ;    helper exe is missing (older install, manually deleted) we skip silently
  ;    and fall through to the taskkill safety net. The CopyFiles /SILENT
  ;    suppresses any user-visible dialog; IfFileExists guards the source so a
  ;    missing helper does not leave a stale $TEMP copy from a prior uninstall.
  IfFileExists "$INSTDIR\resources\daemon\ccsm-uninstall-helper.exe" 0 +5
    SetOutPath "$TEMP"
    CopyFiles /SILENT "$INSTDIR\resources\daemon\ccsm-uninstall-helper.exe" "$TEMP\ccsm-uninstall-helper.exe"
    nsExec::ExecToLog '"$TEMP\ccsm-uninstall-helper.exe" --shutdown --timeout 2000'
    Pop $0  ; helper exit code (logged via ExecToLog; not branched on per r9 P0-2 silent contract)

  ; 2. Hardstop safety net (frag-11 §11.6.1). Covers: helper missing, helper
  ;    exit-1 (hard error), or daemon respawned between graceful shutdown and
  ;    install-root wipe. /T also kills any child processes.
  nsExec::ExecToLog 'taskkill /IM ccsm-daemon.exe /F /T'
  Sleep 500   ; let OS release file handles before $INSTDIR RMDir

  ; 3. Lockfile cleanup (frag-6-7 §6.4 — proper-lockfile leaves a stale lock
  ;    dir on SIGKILL; explicit unlink here closes the race window).
  Delete "$LOCALAPPDATA\ccsm\daemon.lock"

  ; 4. Drop the staged $TEMP helper copy. Best-effort: if step 1 was skipped
  ;    (no helper installed) this is a no-op. We do this AFTER taskkill so the
  ;    helper file is not held open by its own process.
  Delete "$TEMP\ccsm-uninstall-helper.exe"

  ; 5. The install root ($INSTDIR under %LOCALAPPDATA%\ccsm) is wiped by the
  ;    standard NSIS uninstall sequence after this macro returns. User data
  ;    subdirs (data/, logs/, crashes/, daemon.secret) are NOT touched here —
  ;    retained by default per the §11.6 paths table. Opt-in cleanup happens
  ;    in-app (frag-6-7 §6.8) BEFORE uninstall, OR the user manually deletes
  ;    %LOCALAPPDATA%\ccsm\ post-uninstall (release-notes documented).
!macroend

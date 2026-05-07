// Tauri shell entrypoint — Wave-2 T10 (#685) + T12 (#678).
//
// Listener race contract (see ~/.claude/projects/.../project_tauri2_spike_2026_05_07.md):
// `daemon-ready` / `daemon-exit` / `daemon-error` are emitted by the Rust
// side from a `tokio::spawn`-ed task that starts the moment `start_daemon`
// returns Ok. If we `await invoke('start_daemon')` BEFORE registering the
// listeners, fast handshakes can race past us and we lose the event.
//
// Therefore the order below is fixed:
//   1. listen('daemon-ready', ...)   — register, await unlisten Promise
//   2. listen('daemon-exit', ...)    — T12 surfaces this in a UI banner
//   3. listen('daemon-error', ...)
//   4. listen('daemon-stderr', ...)  — optional, log only
//   5. invoke('start_daemon')        — fire spawn AFTER listeners are live
//   6. await readyPromise            — block on first daemon-ready / error
//   7. build hostConfig from handshake
//   8. createRoot(...).render(<ShellRoot hostConfig={...} />)
//
// T12 scope (#678): close (×) + reconnect verification. Close button + WS
// reconnect already work end-to-end via @ccsm/ui Sidebar + @ccsm/core
// SessionRuntime (5-attempt budget, identical to wave-1). The only code
// change required is surfacing `daemon-exit` to the user — T10 only logged
// it to the console. ShellRoot below owns that state and renders a thin
// banner above <App> when the daemon process dies (e.g. external taskkill).

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { App } from './App';
import { buildTauriHostConfig, type Handshake } from './hostConfig';
import type { HostConfig } from '@ccsm/ui';
import '@ccsm/ui/styles.css';

interface DaemonExitEvent {
  code: number | null;
  reason: string;
}
interface DaemonErrorEvent {
  reason: string;
}

interface ShellRootProps {
  hostConfig: HostConfig;
}

/**
 * ShellRoot — owns the post-bootstrap UI state.
 *
 * Currently tracks one thing: whether the daemon process is still alive.
 * `daemon-exit` is emitted by the Rust side when the spawned `node daemon`
 * child exits for any reason (clean shutdown, crash, external taskkill).
 * After bootstrap we are past the readyPromise, so the listener registered
 * in `bootstrap()` is gone; we register a fresh one here that sets state
 * instead of just logging.
 *
 * UX: a single non-dismissable banner above <App>. The user can keep
 * interacting with already-attached sessions (their ws will reconnect up
 * to the SessionRuntime budget then go to `disconnected`), but new
 * actions like + New Session will fail with the existing alert path.
 * Restarting the app re-spawns the daemon (Job Object cleans up first),
 * which is the documented recovery (Plan §C item 1).
 */
function ShellRoot({ hostConfig }: ShellRootProps) {
  const [daemonExit, setDaemonExit] = useState<DaemonExitEvent | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<DaemonExitEvent>('daemon-exit', (e) => {
      // eslint-disable-next-line no-console
      console.warn('[tauri] daemon-exit', e.payload);
      setDaemonExit(e.payload);
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <>
      {daemonExit !== null && (
        <div
          role="alert"
          data-testid="daemon-exit-banner"
          style={{
            background: '#3a1f1f',
            color: '#f5d0d0',
            padding: '6px 12px',
            fontSize: '13px',
            fontFamily: 'system-ui, sans-serif',
            borderBottom: '1px solid #6b2a2a',
          }}
        >
          Daemon offline ({daemonExit.reason}
          {daemonExit.code !== null ? `, code=${daemonExit.code}` : ''}).
          Restart the app to reconnect.
        </div>
      )}
      <App hostConfig={hostConfig} />
    </>
  );
}

async function bootstrap(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('Root element #root not found');

  // Promise that resolves on the first `daemon-ready` event or rejects on
  // the first `daemon-error`. Created BEFORE invoke() so the listener is
  // guaranteed live when the Rust side starts emitting.
  let resolveReady!: (hs: Handshake) => void;
  let rejectReady!: (reason: Error) => void;
  const readyPromise = new Promise<Handshake>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // 1. daemon-ready (one-shot for the initial handshake — we keep the
  //    unlisten so future reloads can clear it; T12 will revisit).
  const unlistenReady: UnlistenFn = await listen<Handshake>(
    'daemon-ready',
    (e) => {
      // eslint-disable-next-line no-console
      console.log('[tauri] daemon-ready', {
        port: e.payload.port,
        tokenLen: e.payload.token.length,
      });
      resolveReady(e.payload);
    },
  );

  // 2. daemon-exit — bootstrap-time listener. We log here AND keep the
  //    listener live (no unlisten on success path) so an exit during the
  //    bootstrap window between invoke() and ShellRoot's effect mounting
  //    is not lost. ShellRoot registers its own listener that drives the
  //    UI banner; events arriving after both are live will fire both
  //    callbacks, which is fine (idempotent: console.warn + setState).
  const unlistenExit: UnlistenFn = await listen<DaemonExitEvent>(
    'daemon-exit',
    (e) => {
      // eslint-disable-next-line no-console
      console.warn('[tauri] daemon-exit', e.payload);
    },
  );

  // 3. daemon-error — handshake failure / spawn failure. If this fires
  //    before daemon-ready, it rejects the bootstrap promise.
  const unlistenError: UnlistenFn = await listen<DaemonErrorEvent>(
    'daemon-error',
    (e) => {
      // eslint-disable-next-line no-console
      console.error('[tauri] daemon-error', e.payload);
      rejectReady(new Error(`daemon-error: ${e.payload.reason}`));
    },
  );

  // 4. daemon-stderr — log forwarder (optional, useful in dev console).
  const unlistenStderr: UnlistenFn = await listen<string>(
    'daemon-stderr',
    (e) => {
      // eslint-disable-next-line no-console
      console.debug('[daemon stderr]', e.payload);
    },
  );

  // 5. invoke spawn — listeners are now live, no race window.
  await invoke('start_daemon');

  // 6. block on first daemon-ready (or daemon-error rejection).
  let handshake: Handshake;
  try {
    handshake = await readyPromise;
  } catch (err) {
    // Clean up listeners so a future retry can re-register cleanly.
    unlistenReady();
    unlistenExit();
    unlistenError();
    unlistenStderr();
    rootEl.textContent = `Failed to start daemon: ${(err as Error).message}`;
    throw err;
  }

  // 7. build hostConfig from the handshake.
  const hostConfig = buildTauriHostConfig(handshake);
  // eslint-disable-next-line no-console
  console.log('[tauri] hostConfig', {
    httpBase: hostConfig.httpBase,
    tokenPresent: !!hostConfig.getToken(),
  });

  // 8. mount the React app with the freshly-built hostConfig wrapped in
  //    ShellRoot so post-bootstrap daemon-exit events surface as a banner.
  createRoot(rootEl).render(
    <StrictMode>
      <ShellRoot hostConfig={hostConfig} />
    </StrictMode>,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[tauri] bootstrap failed', err);
});

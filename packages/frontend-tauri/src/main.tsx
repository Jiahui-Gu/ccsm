// Tauri shell entrypoint — Wave-2 T10 (#685).
//
// Listener race contract (see ~/.claude/projects/.../project_tauri2_spike_2026_05_07.md):
// `daemon-ready` / `daemon-exit` / `daemon-error` are emitted by the Rust
// side from a `tokio::spawn`-ed task that starts the moment `start_daemon`
// returns Ok. If we `await invoke('start_daemon')` BEFORE registering the
// listeners, fast handshakes can race past us and we lose the event.
//
// Therefore the order below is fixed:
//   1. listen('daemon-ready', ...)   — register, await unlisten Promise
//   2. listen('daemon-exit', ...)
//   3. listen('daemon-error', ...)
//   4. listen('daemon-stderr', ...)  — optional, log only
//   5. invoke('start_daemon')        — fire spawn AFTER listeners are live
//   6. await readyPromise            — block on first daemon-ready / error
//   7. build hostConfig from handshake
//   8. createRoot(...).render(<App hostConfig={...} />)
//
// Scope (T10): start daemon, get hostConfig, render the same UI as
// frontend-web (empty session list). Reconnect / token rotation / +new
// session wiring belongs to T11/T12.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { App } from './App';
import { buildTauriHostConfig, type Handshake } from './hostConfig';
import '@ccsm/ui/styles.css';

interface DaemonExitEvent {
  code: number | null;
  reason: string;
}
interface DaemonErrorEvent {
  reason: string;
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

  // 2. daemon-exit — daemon process exited. T10 just logs; T12 will surface
  //    a disconnected state in the UI.
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

  // 8. mount the React app with the freshly-built hostConfig.
  createRoot(rootEl).render(
    <StrictMode>
      <App hostConfig={hostConfig} />
    </StrictMode>,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[tauri] bootstrap failed', err);
});

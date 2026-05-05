/**
 * Wave-2-C: main-process consumer of the daemon's `/api/events/notify` SSE
 * stream. Fires the OS-side `Notification` (toast) for each Decision the
 * daemon emits.
 *
 * Why this lives in main and not the renderer:
 *   - electron `Notification` requires the main process. Forwarding via
 *     `webContents.send` and firing from preload would work too, but that
 *     adds a second hop and we already have a daemon-port channel here.
 *   - The renderer-side hook (`window.ccsmNotify.onNotified`) still fires
 *     in parallel — the renderer uses it to drive the in-window flash
 *     animation. Toast is a separate sink.
 *
 * Why a hand-rolled parser instead of the `eventsource` npm package:
 *   - 30-line parser keeps the dependency surface minimal (audit #876
 *     deps tier — every new dep is a pin we have to chase across electron
 *     major bumps).
 *   - SSE wire format is trivial: `data: <json>\n\n` with `\r?\n` line
 *     terminators. Reconnect glue here mirrors `electron/preload/bridges/_daemon.ts`.
 */

import { app, BrowserWindow, Notification } from 'electron';
import * as http from 'node:http';

import { getDaemonPort } from '../daemon-spawner';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;

interface Decision {
  toast: boolean;
  flash: boolean;
  sid: string;
}

function parseFrames(buffer: string): { frames: string[]; rest: string } {
  // SSE frames are separated by a blank line (\n\n). A frame may contain
  // multiple `data:` lines that need to be joined with `\n`. We're a thin
  // consumer — only `data:` lines matter; `: ping` keepalives and other
  // SSE field lines (event:, id:, retry:) are ignored.
  const frames: string[] = [];
  let rest = buffer;
  while (true) {
    const sep = rest.indexOf('\n\n');
    if (sep < 0) break;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (dataLines.length > 0) frames.push(dataLines.join('\n'));
  }
  return { frames, rest };
}

function showToast(decision: Decision): void {
  if (!decision.toast) return;
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: 'Claude is waiting for input',
      body: decision.sid,
      silent: false,
    }).show();
  } catch {
    /* OS notification surface unavailable — silently drop */
  }
}

function flashTaskbar(decision: Decision): void {
  if (!decision.flash) return;
  // Flash whichever main window currently has focus or is the most recent.
  // On Windows this triggers a taskbar attention blink; on macOS it bounces
  // the dock icon. Linux behaviour varies by WM.
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  try {
    win.flashFrame(true);
  } catch {
    /* unsupported on some Linux WMs — silently drop */
  }
  // Also forward to renderer for the in-window flash animation.
  try {
    win.webContents.send('notify:decision', decision);
  } catch {
    /* renderer not loaded yet — drop */
  }
}

export function installNotifySinkConsumer(): { stop: () => void } {
  let stopped = false;
  let req: http.ClientRequest | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = RECONNECT_MIN_MS;

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  const connect = (): void => {
    if (stopped) return;
    const port = getDaemonPort();
    if (port == null) {
      scheduleReconnect();
      return;
    }
    let buffer = '';
    req = http.get(`http://127.0.0.1:${port}/api/events/notify`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleReconnect();
        return;
      }
      backoff = RECONNECT_MIN_MS;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const { frames, rest } = parseFrames(buffer);
        buffer = rest;
        for (const f of frames) {
          let decision: Decision | null = null;
          try {
            decision = JSON.parse(f) as Decision;
          } catch {
            continue;
          }
          if (!decision || typeof decision.sid !== 'string') continue;
          showToast(decision);
          flashTaskbar(decision);
        }
      });
      res.on('end', () => {
        scheduleReconnect();
      });
      res.on('error', () => {
        scheduleReconnect();
      });
    });
    req.on('error', () => {
      scheduleReconnect();
    });
  };

  // Defer first connect until app is ready — Notification + flashFrame need
  // an Electron app context, and getDaemonPort returns null until daemon
  // spawn resolves anyway.
  if (app.isReady()) {
    connect();
  } else {
    app.once('ready', () => connect());
  }

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
      req = null;
    },
  };
}

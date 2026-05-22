// V2 mobile remote host: connects this Electron instance to the cc-sm
// signaling Worker as `role=host`, runs an RTCPeerConnection (answerer) in a
// hidden BrowserWindow (since WebRTC is a renderer-only Web API), and bridges
// the DataChannel to the existing ptyHost APIs over IPC.
//
// Gated by `CCSM_MOBILE_REMOTE_V2=1` and requires a JWT obtained out-of-band
// via GitHub Device Flow (see `deviceFlow.ts`). The JWT is stashed in
// app.getPath('userData')/.ccsm-remote-jwt for now — replace with safeStorage
// before turning this on by default.

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {
  getBufferSnapshot,
  getPtySession,
  inputPtySession,
  listPtySessions,
  onPtyData,
} from '../ptyHost';

type V2Server = { close: () => void };

const SIGNAL_ORIGIN_DEFAULT = 'https://cc-sm.workers.dev';
const ROOM_DEFAULT = 'default';

export function startMobileRemoteV2(): V2Server | null {
  if (process.env.CCSM_MOBILE_REMOTE_V2 !== '1') return null;

  const origin = process.env.CCSM_REMOTE_ORIGIN || SIGNAL_ORIGIN_DEFAULT;
  const room = process.env.CCSM_REMOTE_ROOM || ROOM_DEFAULT;

  const jwt = readJwt();
  if (!jwt) {
    console.warn(
      '[mobile-remote-v2] no JWT on disk; run GitHub Device Flow first ' +
        '(IPC: remote:device:start). Skipping.',
    );
    return null;
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'mobileRemoteHostPreload.js'),
    },
  });

  const offPtyData = onPtyData((sid, chunk) => {
    if (win.isDestroyed()) return;
    win.webContents.send('remote-v2:pty-data', { sid, chunk });
  });

  const handleHostMsg = async (
    _e: Electron.IpcMainEvent,
    raw: unknown,
  ): Promise<void> => {
    if (!isRecord(raw) || typeof raw.type !== 'string') return;
    if (raw.type === 'sessions.list') {
      win.webContents.send('remote-v2:dc-send', {
        type: 'sessions.list',
        sessions: listPtySessions(),
      });
      return;
    }
    if (raw.type === 'session.snapshot' && typeof raw.sid === 'string') {
      const snapshot = await getBufferSnapshot(raw.sid);
      const info = getPtySession(raw.sid);
      win.webContents.send('remote-v2:dc-send', {
        type: 'session.snapshot',
        sid: raw.sid,
        cols: info?.cols ?? null,
        rows: info?.rows ?? null,
        ...snapshot,
      });
      return;
    }
    if (
      raw.type === 'session.input' &&
      typeof raw.sid === 'string' &&
      typeof raw.data === 'string'
    ) {
      inputPtySession(raw.sid, raw.data);
      return;
    }
  };
  ipcMain.on('remote-v2:dc-recv', handleHostMsg);

  const htmlPath = path.join(__dirname, 'mobileRemoteHostPage.html');
  const params = new URLSearchParams({ origin, room, jwt });
  // mobileRemoteHostPage.html is shipped alongside the compiled JS via the
  // copy-remote-assets prebuild step (see scripts/copy-remote-assets.cjs).
  win.loadFile(htmlPath, { search: params.toString() }).catch((e) => {
    console.error('[mobile-remote-v2] loadFile failed:', e);
  });

  return {
    close: () => {
      offPtyData();
      ipcMain.removeListener('remote-v2:dc-recv', handleHostMsg);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function jwtPath(): string {
  return path.join(app.getPath('userData'), '.ccsm-remote-jwt');
}

export function readJwt(): string | null {
  try {
    const s = fs.readFileSync(jwtPath(), 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

export function writeJwt(jwt: string): void {
  fs.writeFileSync(jwtPath(), jwt, { encoding: 'utf8', mode: 0o600 });
}

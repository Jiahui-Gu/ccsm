// GitHub Device Flow login for the V2 mobile remote host. Triggered via IPC
// (`remote-v2:device:start`). Opens the GitHub verification URL in the user's
// default browser, polls the cc-sm Worker until the user completes auth, then
// stashes the returned JWT on disk for `startMobileRemoteV2` to pick up.

import { ipcMain, shell } from 'electron';
import { writeJwt } from './mobileRemoteHostV2';

const SIGNAL_ORIGIN_DEFAULT = 'https://cc-sm.workers.dev';

type DeviceCodeResp = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type PollResp =
  | { jwt: string; login: string }
  | { error: string }
  | Record<string, unknown>;

async function startDeviceFlow(origin: string): Promise<{ login: string }> {
  const codeRes = await fetch(`${origin}/api/device/code`, { method: 'POST' });
  if (!codeRes.ok) throw new Error(`device/code ${codeRes.status}`);
  const code = (await codeRes.json()) as DeviceCodeResp;
  console.log(
    `[remote-v2-device] open ${code.verification_uri} and enter code: ${code.user_code}`,
  );
  await shell.openExternal(code.verification_uri);

  const deadline = Date.now() + code.expires_in * 1000;
  const intervalMs = Math.max(code.interval ?? 5, 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const r = await fetch(`${origin}/api/device/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: code.device_code }),
    });
    const j = (await r.json()) as PollResp;
    if ('jwt' in j && typeof j.jwt === 'string' && typeof j.login === 'string') {
      writeJwt(j.jwt);
      return { login: j.login };
    }
    if ('error' in j && j.error && j.error !== 'authorization_pending' && j.error !== 'slow_down') {
      throw new Error(String(j.error));
    }
  }
  throw new Error('device flow expired');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerDeviceFlowIpc(): void {
  ipcMain.handle('remote-v2:device:start', async () => {
    const origin = process.env.CCSM_REMOTE_ORIGIN || SIGNAL_ORIGIN_DEFAULT;
    return startDeviceFlow(origin);
  });
}

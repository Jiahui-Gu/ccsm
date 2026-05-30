import * as crypto from 'crypto';
import * as http from 'http';
import { onPtyData } from '../ptyHost';
import { renderMobilePage } from './mobilePage';
import { displayHost, parseRequestUrl, resolveHost, resolvePort, sendHtml, sendJson, sendText, tokenMatches } from './remoteHttp';
import { handleClientMessage, listEntries, listSignature } from './remoteMessages';
import {
  buildUpgradeResponse,
  closeSocket,
  decodeFrames,
  encodeControlFrame,
  encodeFrame,
  type WsClient,
} from './wsProtocol';

type MobileRemoteServer = {
  close: () => void;
  /** The full local URL (including the bearer token) the desktop UI/user can
   *  use to connect. Kept off stdout — the token is never logged in full — so
   *  callers retrieve it from here rather than scraping the console. */
  url: string;
};

export function startMobileRemoteServer(options?: {
  /** Heartbeat sweep interval in ms. Test-only seam — production always uses
   *  the 30 s default. Lets unit tests drive the half-open reap in ~50 ms
   *  instead of waiting two real 30 s intervals. */
  heartbeatMs?: number;
}): MobileRemoteServer | null {
  if (process.env.CCSM_MOBILE_REMOTE !== '1') return null;

  const heartbeatMs = options?.heartbeatMs ?? 30_000;
  const token = crypto.randomBytes(32).toString('base64url');
  const port = resolvePort(process.env.CCSM_MOBILE_REMOTE_PORT);
  const boundHost = resolveHost(process.env.CCSM_MOBILE_REMOTE_HOST);
  const clients = new Set<WsClient>();

  const server = http.createServer((req, res) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (url.pathname === '/') {
      if (!tokenMatches(url.searchParams.get('token'), token)) {
        sendText(res, 401, 'Unauthorized');
        return;
      }
      sendHtml(res, renderMobilePage());
      return;
    }

    if (url.pathname === '/manifest.webmanifest') {
      if (!tokenMatches(url.searchParams.get('token'), token)) {
        sendText(res, 401, 'Unauthorized');
        return;
      }
      // start_url carries the same session token so a home-screen icon
      // reconnects authenticated. No new secret — it's the token already in
      // the URL the user loaded.
      sendJson(res, {
        name: 'CCSM Remote',
        short_name: 'CCSM',
        display: 'standalone',
        background_color: '#0b1020',
        theme_color: '#0b1020',
        start_url: `/?token=${token}`,
        scope: '/',
      });
      return;
    }

    sendText(res, 404, 'Not found');
  });

  server.on('upgrade', (req, socket) => {
    const url = parseRequestUrl(req.url);
    if (!url || url.pathname !== '/ws' || !tokenMatches(url.searchParams.get('token'), token)) {
      // socket.end() flushes the HTTP response before sending FIN; a bare
      // destroy() would race the kernel and the peer may miss the 401 body
      // on Windows. Same pattern PR #1341 applied to closeSocket().
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      // See 401 path above — flush before FIN so the peer sees the 400 body.
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    socket.write(buildUpgradeResponse(key));
    const client: WsClient = {
      socket,
      pending: Buffer.alloc(0),
      fragment: Buffer.alloc(0),
      subscribedSid: null,
      isAlive: true,
      send: (payload) => {
        if (socket.destroyed) return;
        socket.write(encodeFrame(JSON.stringify(payload)));
      },
    };
    clients.add(client);
    client.send({ type: 'auth.ok' });
    client.send({ type: 'sessions.list', sessions: listEntries() });

    socket.on('data', (chunk) => {
      client.pending = Buffer.concat([client.pending, chunk]);
      const decoded = decodeFrames(client);
      if (decoded.kind === 'fatal') {
        closeSocket(socket, decoded.code);
        clients.delete(client);
        return;
      }
      // Any inbound pong or message proves the socket is still alive — keep the
      // heartbeat sweep from reaping it. Browsers auto-Pong our Pings at the WS
      // layer, so a live phone always trips this within one interval.
      if (decoded.pongReceived || decoded.messages.length > 0) {
        client.isAlive = true;
      }
      for (const message of decoded.messages) {
        void handleClientMessage(client, message);
      }
      for (const pong of decoded.pongs) {
        if (!socket.destroyed) socket.write(encodeControlFrame(0xa, pong));
      }
      if (decoded.close) {
        closeSocket(socket, 1000);
        clients.delete(client);
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  const offPtyData = onPtyData((sid, chunk, seq) => {
    // seq is ptyHost's authoritative per-session chunk counter — the SAME one
    // getBufferSnapshot captures. Forward it verbatim so the client can dedupe
    // live chunks already baked into a snapshot (drop seq <= snapSeq). Earlier
    // this server kept its own seqBySid counter starting at 0, which diverged
    // from ptyHost's and made the client drop every live chunk after a
    // non-empty snapshot — a frozen mobile terminal.
    for (const client of clients) {
      // Only forward this session's bytes to clients viewing it. Without this
      // gate every client receives every session's raw terminal output over
      // the wire — a cross-session data leak (the HTML client only filters for
      // display, not on the network).
      if (client.subscribedSid !== sid) continue;
      client.send({ type: 'pty.data', sid, chunk, seq });
    }
  });

  const shownHost = displayHost(boundHost);
  const url = `http://${shownHost}:${port}/?token=${token}`;

  // The mobile client has no way to learn that a desktop session opened or
  // closed unless we tell it. Poll the live list and re-broadcast only when the
  // set of sessions changes (by sid+cwd), so a phone that was on the page when
  // a new session started picks it up without a manual refresh.
  let lastListSig = listSignature(listEntries());
  const listPollTimer = setInterval(() => {
    if (clients.size === 0) return;
    const entries = listEntries();
    const sig = listSignature(entries);
    if (sig === lastListSig) return;
    lastListSig = sig;
    for (const client of clients) client.send({ type: 'sessions.list', sessions: entries });
  }, 2000);
  listPollTimer.unref();

  // Half-open detection: a phone that drops off the network (airplane mode,
  // tunnel, Wi-Fi→cellular handoff) gives no TCP FIN for minutes, so
  // socket.on('close')/'error' never fire and the dead WsClient lingers in the
  // set — still targeted by the pty.data fan-out and list-poll broadcasts.
  // Each sweep reaps any client that produced no inbound Pong/message since the
  // previous sweep, then Pings the survivors. Browsers auto-Pong at the WS
  // layer, so a live phone always re-arms isAlive within one interval. Worst
  // case a dead client is reaped within ~2× heartbeatMs (one sweep to clear the
  // flag, one to detect it stayed clear).
  const heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        closeSocket(client.socket, 1001);
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      if (!client.socket.destroyed) {
        client.socket.write(encodeControlFrame(0x9, Buffer.alloc(0)));
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref();

  server.listen(port, boundHost, () => {
    // Redact the bearer token in the persistent log line: stdout/stderr get
    // captured into bug reports and shared, and a full token there is a
    // credential leak. The host:port/path stay discoverable; the full URL
    // (with token) is exposed on the returned handle's `url` field for the
    // desktop UI/user to retrieve without it ever hitting the console.
    const tokenHint = token.slice(0, 6);
    console.log(
      `[mobile-remote] listening on ${boundHost}:${port}/?token=${tokenHint}… ` +
        `(full URL on the desktop session handle)`,
    );
    if (boundHost !== '127.0.0.1') {
      // The server is reachable beyond loopback — make that explicit in the log
      // so a user scanning output understands network exposure is active. The
      // token is still required; this is not an open port.
      console.log(
        `[mobile-remote] reachable on the LAN at http://${shownHost}:${port} (token required)`,
      );
    }
  });

  server.on('error', (err) => {
    console.error('[mobile-remote] server error:', err);
  });

  return {
    url,
    close: () => {
      offPtyData();
      clearInterval(listPollTimer);
      clearInterval(heartbeatTimer);
      // Send a 1001 (going-away) close frame per client and let the FIN
      // follow naturally via socket.end() inside closeSocket(). A bare
      // destroy() would emit a raw TCP RST and peers would never see the
      // close reason — same anti-pattern PR #1341 fixed in the fatal-frame
      // path.
      for (const client of clients) closeSocket(client.socket, 1001);
      clients.clear();
      server.close();
    },
  };
}

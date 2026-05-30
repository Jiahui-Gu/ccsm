import * as crypto from 'crypto';
import * as http from 'http';
import { onPtyData } from '../ptyHost';
import { renderMobilePage } from './mobilePage';
import { HOST, parseRequestUrl, resolvePort, sendHtml, sendJson, sendText, tokenMatches } from './remoteHttp';
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

export function startMobileRemoteServer(): MobileRemoteServer | null {
  if (process.env.CCSM_MOBILE_REMOTE !== '1') return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const port = resolvePort(process.env.CCSM_MOBILE_REMOTE_PORT);
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

  const url = `http://${HOST}:${port}/?token=${token}`;

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

  server.listen(port, HOST, () => {
    // Redact the bearer token in the persistent log line: stdout/stderr get
    // captured into bug reports and shared, and a full token there is a
    // credential leak. The host:port/path stay discoverable; the full URL
    // (with token) is exposed on the returned handle's `url` field for the
    // desktop UI/user to retrieve without it ever hitting the console.
    const tokenHint = token.slice(0, 6);
    console.log(
      `[mobile-remote] listening at http://${HOST}:${port}/?token=${tokenHint}… ` +
        `(full URL on the desktop session handle)`,
    );
    console.log(`[mobile-remote] tailscale: tailscale serve --bg http://${HOST}:${port}`);
  });

  server.on('error', (err) => {
    console.error('[mobile-remote] server error:', err);
  });

  return {
    url,
    close: () => {
      offPtyData();
      clearInterval(listPollTimer);
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

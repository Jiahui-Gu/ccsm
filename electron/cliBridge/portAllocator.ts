// Pick an ephemeral free TCP port on 127.0.0.1 by asking the OS to bind
// port 0 on a throwaway server, reading back the assigned port, and
// closing immediately. There is an inherent TOCTOU window between this
// close and the subsequent ttyd spawn — small enough on a single dev
// machine that we accept it (the spike has been running this pattern
// reliably for the duration of the ttyd POC). If we ever hit a real race
// in production, the right fix is "spawn ttyd, parse its `Listening on
// http://127.0.0.1:<port>` log line", not pre-allocation here.
//
// Pattern lifted verbatim from spike/ttyd-embed/main.js (PR #427).

import * as net from 'node:net';

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('port allocator: unexpected unix-socket address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

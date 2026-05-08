// Pick an OS-assigned free TCP port by binding to :0, reading the bound port,
// then closing. Used by the smoke orchestrator to avoid colliding on the
// vite default dev port (1420) when smoke and a developer's own
// `pnpm tauri dev` happen to overlap, or when CI runs multiple smoke
// invocations on the same host. There's an inherent race window between
// close() and the consumer re-binding, but for our single-shot orchestrator
// (one bind per process, immediate handoff to vite/tauri) it's fine.
import { createServer } from 'node:net';

export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        rejectPort(new Error(`unexpected server.address(): ${String(addr)}`));
        return;
      }
      const { port } = addr;
      srv.close((closeErr) => {
        if (closeErr !== undefined && closeErr !== null) {
          rejectPort(closeErr);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

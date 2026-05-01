// daemon/src/crash/handlers.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type pino from 'pino';

export interface InstallOpts {
  logger: pino.Logger;
  bootNonce: string;
  runtimeRoot: string;
  getLastTraceId: () => string | undefined;
  processRef?: NodeJS.Process;
}

interface MarkerV1 {
  schemaVersion: 1;
  bootNonce: string;
  ts: string;
  surface: 'daemon-uncaught';
  kind: 'uncaughtException' | 'unhandledRejection';
  message: string;
  stack?: string;
  lastTraceId?: string;
}

export function installCrashHandlers(opts: InstallOpts): void {
  const proc = opts.processRef ?? process;
  const crashDir = path.join(opts.runtimeRoot, 'crash');
  fs.mkdirSync(crashDir, { recursive: true });
  const markerPath = path.join(crashDir, `${opts.bootNonce}.json`);

  function record(kind: MarkerV1['kind'], errLike: unknown): void {
    const err = errLike instanceof Error ? errLike : new Error(String(errLike));
    const marker: MarkerV1 = {
      schemaVersion: 1,
      bootNonce: opts.bootNonce,
      ts: new Date().toISOString(),
      surface: 'daemon-uncaught',
      kind,
      message: err.message,
      stack: err.stack,
      lastTraceId: opts.getLastTraceId(),
    };
    try {
      opts.logger.fatal({ event: 'daemon.crash', kind, err: { message: err.message, stack: err.stack } });
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
    } catch (e) {
      try { opts.logger.fatal({ event: 'daemon.crash.write_failed', err: String(e) }); } catch {}
    }
    try { (proc as any).exit(70); } catch {}
  }

  proc.on('uncaughtException', (err) => record('uncaughtException', err));
  proc.on('unhandledRejection', (reason) => record('unhandledRejection', reason));
}

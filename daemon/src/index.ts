import { ulid } from 'ulid';
import pino from 'pino';
import { createRequire } from 'node:module';
import { SUPERVISOR_RPCS } from './envelope/supervisor-rpcs.js';

const require = createRequire(import.meta.url);
const DAEMON_VERSION = (require('../../package.json') as { version: string }).version;

// T11 landed the canonical export; T16 owns the control-socket dispatcher
// that actually routes on this allowlist. Keep a `void` reference here so
// the import stays live until T16 wires it.
void SUPERVISOR_RPCS;

const bootNonce = ulid();

const logger = pino({
  base: {
    side: 'daemon',
    v: DAEMON_VERSION,
    pid: process.pid,
    boot: bootNonce,
  },
});

logger.info({ event: 'daemon.boot' }, 'daemon shell booted');

// TODO(T20): full ordered shutdown sequence (heartbeats → drain → SIGCHLD wind-down
// → subscriber close → pino.final) per spec §6.6.1. T1 ships the SIGTERM stub only.
process.on('SIGTERM', () => {
  logger.info({ event: 'daemon.signal.sigterm' }, 'sigterm received');
  process.exit(0);
});

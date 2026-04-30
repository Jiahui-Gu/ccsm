import { ulid } from 'ulid';
import pino from 'pino';

// TODO(T16): replace placeholder with the canonical SUPERVISOR_RPCS dispatcher
// declared in spec §3.4.1.h. Listed literals only — control-plane carve-out.
const SUPERVISOR_RPCS = [
  '/healthz',
  '/stats',
  'daemon.hello',
  'daemon.shutdown',
  'daemon.shutdownForUpgrade',
] as const;
void SUPERVISOR_RPCS;

const bootNonce = ulid();

const logger = pino({
  base: {
    v: process.versions.node,
    pid: process.pid,
    bootNonce,
    side: 'daemon',
  },
});

logger.info({ event: 'daemon.boot' }, 'daemon shell booted');

// TODO(T20): full ordered shutdown sequence (heartbeats → drain → SIGCHLD wind-down
// → subscriber close → pino.final) per spec §6.6.1. T1 ships the SIGTERM stub only.
process.on('SIGTERM', () => {
  logger.info({ event: 'daemon.signal.sigterm' }, 'sigterm received');
  process.exit(0);
});

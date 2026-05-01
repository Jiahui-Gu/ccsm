import { ulid } from 'ulid';
import pino from 'pino';
import { createRequire } from 'node:module';
import { createSupervisorDispatcher } from './dispatcher.js';

const require = createRequire(import.meta.url);
const DAEMON_VERSION = (require('../../package.json') as { version: string }).version;

// T16 wires the control-socket dispatcher; T17–T21 each replace one of the
// SUPERVISOR_RPCS stubs (NOT_IMPLEMENTED today) with a real handler. The
// transport binding (T14) consumes this dispatcher from a Duplex socket.
const supervisorDispatcher = createSupervisorDispatcher();
void supervisorDispatcher;

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

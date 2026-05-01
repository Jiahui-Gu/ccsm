import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { shouldSpawnDaemon } from './double-bind-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const configPath = resolve(repoRoot, 'nodemon.daemon.json');

const PREFIX = '\x1b[33m[daemon]\x1b[0m ';

function pipe(stream: NodeJS.ReadableStream, sink: NodeJS.WriteStream): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) sink.write(`${PREFIX}${line}\n`);
  });
  stream.on('end', () => {
    if (buf.length > 0) sink.write(`${PREFIX}${buf}\n`);
  });
}

function startNodemon(): void {
  const isWin = process.platform === 'win32';
  const nodemonBin = isWin ? 'nodemon.cmd' : 'nodemon';

  const nodemonArgs = ['--config', configPath];
  if (process.env.CCSM_DAEMON_INSPECT === '1') {
    // Override nodemon.daemon.json `exec` to inject --inspect=9230 on the tsx
    // child process. Env-gated so prod / default dev stays portless.
    nodemonArgs.push('--exec', 'tsx --inspect=9230 daemon/src/index.ts');
  }

  const child = spawn(nodemonBin, nodemonArgs, {
    cwd: repoRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    shell: isWin,
  });

  if (child.stdout) pipe(child.stdout, process.stdout);
  if (child.stderr) pipe(child.stderr, process.stderr);

  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };

  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGHUP', () => forward('SIGHUP'));

  child.on('exit', (code, signal) => {
    process.stdout.write(`${PREFIX}nodemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`);
    process.exit(code ?? (signal ? 1 : 0));
  });

  child.on('error', (err) => {
    process.stderr.write(`${PREFIX}failed to spawn nodemon: ${err.message}\n`);
    process.exit(1);
  });
}

// T72 — pre-spawn double-bind guard. nodemon double-fires on rapid file
// saves; if a previous daemon is still bound to the control socket, the new
// node child trips EADDRINUSE. Probe first, exit cleanly if a daemon is
// already alive (the operator can re-trigger by saving again, and nodemon
// will pick up after the previous process releases the bind).
shouldSpawnDaemon().then(
  (proceed) => {
    if (!proceed) {
      process.exit(0);
    }
    startNodemon();
  },
  (err: Error) => {
    process.stderr.write(`${PREFIX}double-bind-guard failed: ${err.message}; spawning anyway\n`);
    startNodemon();
  },
);

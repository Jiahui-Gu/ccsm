import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const isWin = process.platform === 'win32';
const nodemonBin = isWin ? 'nodemon.cmd' : 'nodemon';

const child = spawn(nodemonBin, ['--config', configPath], {
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

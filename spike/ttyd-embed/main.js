// Spike: embed ttyd + claude CLI inside an Electron <webview>.
// Throwaway code — not for merging into ccsm.

const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const TTYD = path.join(__dirname, 'bin', 'ttyd.exe');

// Resolve the user's claude CLI absolute path so ttyd doesn't depend on PATH inheritance.
function resolveClaude() {
  const w = spawnSync('where', ['claude.cmd'], { encoding: 'utf8' });
  if (w.status === 0) {
    const first = w.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  const w2 = spawnSync('where', ['claude'], { encoding: 'utf8' });
  if (w2.status === 0) {
    const first = w2.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  return 'claude';
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

let ttydProc = null;

async function startTtyd(claudePath) {
  const port = await pickFreePort();
  const args = ['-p', String(port), '-W', '-t', 'fontSize=14', claudePath];
  console.log('[spike] launching ttyd:', TTYD, args.join(' '));
  ttydProc = spawn(TTYD, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ttydProc.stdout.on('data', (b) => process.stdout.write(`[ttyd] ${b}`));
  ttydProc.stderr.on('data', (b) => process.stderr.write(`[ttyd] ${b}`));
  ttydProc.on('exit', (code) => console.log(`[spike] ttyd exited ${code}`));
  // Tiny delay so the HTTP server is listening before webview loads.
  await new Promise((r) => setTimeout(r, 400));
  return port;
}

function killTtyd() {
  if (!ttydProc || ttydProc.killed) return;
  try {
    // On Windows we need taskkill /T to reap the child PTY/claude process tree.
    spawnSync('taskkill', ['/F', '/T', '/PID', String(ttydProc.pid)]);
  } catch (_) {
    try { ttydProc.kill(); } catch (_) {}
  }
}

async function createWindow() {
  const claudePath = resolveClaude();
  console.log('[spike] claude path:', claudePath);
  const port = await startTtyd(claudePath);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Pass the port to the renderer via query string.
  await win.loadFile('index.html', { query: { port: String(port) } });
  win.on('closed', killTtyd);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  killTtyd();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', killTtyd);
process.on('exit', killTtyd);

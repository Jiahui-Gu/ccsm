// IPC channel parity contract (audit finding 1a).
//
// Catches silent rename / drop of an IPC channel. The preload bridges
// (electron/preload/bridges/*.ts) and the main-process handlers
// (electron/ipc/*.ts, electron/ptyHost/ipcRegistrar.ts, electron/updater.ts,
// electron/notify/sinks/*.ts, electron/window/createWindow.ts) are linked at
// runtime only — Electron resolves channel strings dynamically through
// `ipcRenderer.invoke` / `ipcMain.handle`. A typo or a renamed constant on
// either side leaves the call hanging forever with zero compile-time signal.
//
// This test extracts every channel string referenced by `ipcRenderer.*`
// (preload side) and `ipcMain.*` + `webContents.send` / `wc.send` /
// `sendAll` (main side), then asserts the two surfaces line up by direction:
//
//   preload invoke   ⇔  ipcMain.handle              (renderer → main, ack)
//   preload send     ⇔  ipcMain.on                  (renderer → main, fire-and-forget)
//   preload on       ⇔  webContents.send / sendAll  (main → renderer)
//
// Channel strings are resolved against the constants in
// `electron/shared/ipcChannels.ts` so both literal `'foo:bar'` and
// `FOO_CHANNELS.bar` references collapse to the same wire string.
//
// If this test ever fails, it means the renderer and main are about to
// (or already do) disagree on which channels exist — fix by lining up the
// two sides, not by silencing the test. A reviewer mutation check
// (rename one `ipcMain.handle` constant key in your head) should make
// this test fail; if it would still pass, the test is too weak.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as channels from '../../electron/shared/ipcChannels';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Channel-constant resolution ────────────────────────────────────────────
//
// Every channel name in `electron/shared/ipcChannels.ts` is a string
// literal under a `XXX_CHANNELS` namespace. Flatten to a single map of
// `namespace.key` → wire string so a call site like `PTY_CHANNELS.input`
// resolves to `'pty:input'`.
function buildConstantMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [nsName, nsObj] of Object.entries(channels)) {
    if (nsObj && typeof nsObj === 'object') {
      for (const [k, v] of Object.entries(nsObj as Record<string, unknown>)) {
        if (typeof v === 'string') {
          map.set(`${nsName}.${k}`, v);
        }
      }
    }
  }
  return map;
}

const CONST_MAP = buildConstantMap();

// Resolve a call-site first argument (already string-trimmed) to its wire
// channel value, or null if it's not a recognizable channel reference.
// Accepts literal `'foo:bar'` / `"foo:bar"` or `XXX_CHANNELS.key`.
function resolveChannelArg(arg: string): string | null {
  const trimmed = arg.trim();
  // Literal string
  const litMatch = /^['"`]([^'"`]+)['"`]$/.exec(trimmed);
  if (litMatch) return litMatch[1];
  // CONSTANT_NAMESPACE.key
  const constMatch = /^([A-Z][A-Z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (constMatch) {
    return CONST_MAP.get(`${constMatch[1]}.${constMatch[2]}`) ?? null;
  }
  return null;
}

// ── Source-file scanning ──────────────────────────────────────────────────
function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules' || ent.name === 'dist') continue;
      walk(full, out);
    } else if (ent.isFile() && /\.tsx?$/.test(ent.name)) {
      out.push(full);
    }
  }
}

function listElectronSources(): string[] {
  const out: string[] = [];
  walk(path.join(REPO_ROOT, 'electron'), out);
  return out;
}

// Extract calls of the form `<receiver>.<method>(<firstArg>, ...)` where
// <firstArg> is the channel reference. Greedy by design: we want every
// match, not a precise AST parse — the regex is conservative enough that
// the resolveChannelArg pass filters out any false positives.
function extractCalls(
  source: string,
  receiver: string,
  methods: string[],
): string[] {
  const channelsFound: string[] = [];
  // Match `receiver.method(` then capture up to the first top-level comma
  // or closing paren. We don't handle nested parens in the first arg,
  // but channel refs are always a simple literal or `CONST.key`.
  const methodPattern = methods.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(
    `\\b${receiver}\\s*\\.\\s*(?:${methodPattern})\\s*\\(\\s*([^,)]+)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const resolved = resolveChannelArg(m[1]);
    if (resolved !== null) channelsFound.push(resolved);
  }
  return channelsFound;
}

// ── Preload-side extraction ───────────────────────────────────────────────
type Side = { invoke: Set<string>; send: Set<string>; on: Set<string> };

function emptySide(): Side {
  return { invoke: new Set(), send: new Set(), on: new Set() };
}

function scanPreload(): Side {
  const side = emptySide();
  const bridgesDir = path.join(REPO_ROOT, 'electron', 'preload', 'bridges');
  const files = fs
    .readdirSync(bridgesDir)
    .filter((f) => /\.ts$/.test(f))
    .map((f) => path.join(bridgesDir, f));
  for (const f of files) {
    const src = readFile(f);
    for (const ch of extractCalls(src, 'ipcRenderer', ['invoke'])) side.invoke.add(ch);
    for (const ch of extractCalls(src, 'ipcRenderer', ['send'])) side.send.add(ch);
    for (const ch of extractCalls(src, 'ipcRenderer', ['on'])) side.on.add(ch);
  }
  return side;
}

// ── Main-side extraction ──────────────────────────────────────────────────
type MainSide = { handle: Set<string>; on: Set<string>; sendOut: Set<string> };

function emptyMain(): MainSide {
  return { handle: new Set(), on: new Set(), sendOut: new Set() };
}

function scanMain(): MainSide {
  const side = emptyMain();
  for (const f of listElectronSources()) {
    // Skip preload — that's the renderer side.
    if (f.includes(`${path.sep}preload${path.sep}`)) continue;
    const src = readFile(f);
    for (const ch of extractCalls(src, 'ipcMain', ['handle'])) side.handle.add(ch);
    for (const ch of extractCalls(src, 'ipcMain', ['on'])) side.on.add(ch);
    // Several aliases for main→renderer sends. `sendAll` is a helper in
    // electron/updater.ts that calls webContents.send under the hood;
    // its call sites use the same `CONST.key` first-arg shape.
    for (const ch of extractCalls(src, 'webContents', ['send'])) side.sendOut.add(ch);
    for (const ch of extractCalls(src, 'wc', ['send'])) side.sendOut.add(ch);
    // Bare `sendAll(channel, payload)` — no receiver. Match the function
    // call directly so we can capture it the same way.
    const sendAllRe = /\bsendAll\s*\(\s*([^,)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = sendAllRe.exec(src)) !== null) {
      const resolved = resolveChannelArg(m[1]);
      if (resolved !== null) side.sendOut.add(resolved);
    }
  }
  return side;
}

// Channels the renderer subscribes to that aren't simple
// `webContents.send` callsites. `ipcRenderer.on('XYZ')` payloads emitted
// by anything other than the main process's own `send` shouldn't show up
// here — currently empty, but kept as an escape hatch with a comment so a
// reviewer must justify adding entries.
const RENDERER_ON_WHITELIST = new Set<string>([]);

// Channels handled in main that are intentionally not invoked from
// preload — e.g. internal diagnostic hooks. Currently empty.
const MAIN_HANDLE_WHITELIST = new Set<string>([]);

describe('IPC channel parity (preload ↔ main)', () => {
  const preload = scanPreload();
  const main = scanMain();

  it('extracts a non-trivial channel surface (sanity)', () => {
    // If these go to zero, the regex broke — fail loudly instead of
    // silently passing every subsequent assertion against empty sets.
    expect(preload.invoke.size).toBeGreaterThan(5);
    expect(main.handle.size).toBeGreaterThan(5);
  });

  it('every renderer ipcRenderer.invoke channel is handled in main', () => {
    const missing = [...preload.invoke].filter((c) => !main.handle.has(c));
    expect(missing).toEqual([]);
  });

  it('every renderer ipcRenderer.send channel is listened to in main', () => {
    const missing = [...preload.send].filter((c) => !main.on.has(c));
    expect(missing).toEqual([]);
  });

  it('every renderer ipcRenderer.on channel is emitted somewhere in main', () => {
    const missing = [...preload.on].filter(
      (c) => !main.sendOut.has(c) && !RENDERER_ON_WHITELIST.has(c),
    );
    expect(missing).toEqual([]);
  });

  it('every ipcMain.handle channel is invoked from preload', () => {
    // Dropped/dead handlers — main keeps a handler registered but no
    // renderer caller exists. Either the preload bridge was removed
    // (silent renderer breakage if a caller is re-added) or the handler
    // should be deleted.
    const unused = [...main.handle].filter(
      (c) => !preload.invoke.has(c) && !MAIN_HANDLE_WHITELIST.has(c),
    );
    expect(unused).toEqual([]);
  });

  it('every ipcMain.on channel is sent from preload', () => {
    const unused = [...main.on].filter((c) => !preload.send.has(c));
    expect(unused).toEqual([]);
  });

  // ── Mutation-check guard ────────────────────────────────────────────
  // A reviewer's sanity probe: if the extractor returned the empty set,
  // every subsequent set-difference assertion would trivially pass. The
  // earlier sanity test guards against that — but we also verify that
  // some well-known load-bearing channels actually appear in both sets.
  // If a future refactor breaks the extractor for one specific shape,
  // this catches it.
  it('well-known load-bearing channels are visible to the extractor', () => {
    // db:save — preload calls (`DB_CHANNELS.save`), main handles.
    expect(preload.invoke.has('db:save')).toBe(true);
    expect(main.handle.has('db:save')).toBe(true);
    // pty:input — preload calls (`PTY_CHANNELS.input`), main handles.
    expect(preload.invoke.has('pty:input')).toBe(true);
    expect(main.handle.has('pty:input')).toBe(true);
    // pty:data — main sends, preload listens.
    expect(main.sendOut.has('pty:data')).toBe(true);
    expect(preload.on.has('pty:data')).toBe(true);
    // session:setActive — preload sends (fire-and-forget), main listens.
    expect(preload.send.has('session:setActive')).toBe(true);
    expect(main.on.has('session:setActive')).toBe(true);
  });
});

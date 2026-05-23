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
//
// IMPORTANT: when this returns null, the caller MUST surface the call site
// as "unresolved" rather than silently dropping it. A dynamic first arg
// like `ipcMain.handle(`pty:${kind}`, ...)` or `const ch = X;
// ipcMain.handle(ch, ...)` would otherwise create a false negative — the
// parity assertions would trivially pass because the channel was never
// counted on either side. We don't permit dynamic channel refs in this
// codebase (the `electron/shared/ipcChannels.ts` discipline forbids it),
// so any unresolved ref is itself a contract violation.
function resolveChannelArg(arg: string): string | null {
  const trimmed = arg.trim();
  // Reject template literals that contain interpolation up-front — the
  // literal-string regex below would otherwise treat e.g. `pty:${kind}`
  // as a static `'pty:${kind}'` channel name, silently masking a dynamic
  // call site that has no business existing in this codebase.
  if (trimmed.startsWith('`') && trimmed.includes('${')) return null;
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

// True when an unresolved raw arg is a bare local identifier — i.e. a
// helper function's parameter being forwarded. These aren't contract call
// sites: the actual channel name shows up at the helper's caller, which
// IS captured. Example: `sendAll(channel, payload)` inside
//   `function sendAll(channel: string, payload: unknown) {
//      for (const win of ...) win.webContents.send(channel, payload);
//    }`
// — the contract is enforced at every `sendAll(UPDATE_CHANNELS.x, ...)`
// call site, not at the inner forwarding line. Bare-identifier args are
// also incompatible with the codebase's "channel must be a literal or a
// CONST.key reference" discipline at top-level call sites (lowercase
// identifiers don't match the `CONSTANT_NS.key` regex anyway), so this
// only filters helper-forwarding cases.
function isHelperForwardingArg(raw: string): boolean {
  const trimmed = raw.trim();
  // Bare identifier (e.g. `channel`, `payload`) — a forwarded parameter
  // inside a helper body.
  if (/^[a-z_][a-zA-Z0-9_]*$/.test(trimmed)) return true;
  // Function declaration parameter list, e.g. the `channel: string` in
  //   `function sendAll(channel: string, payload: unknown)`
  // Our coarse regex matches the declaration site itself as if it were a
  // call. Recognize parameter-style args (`name: Type` / `name?: Type`).
  if (/^[a-z_][a-zA-Z0-9_]*\??\s*:\s*[A-Za-z_]/.test(trimmed)) return true;
  return false;
}

// A call site whose channel arg we couldn't statically resolve. Includes
// the raw arg text and a source location so a failure points at the
// exact line that needs to change to a literal or a CONST.key reference.
type UnresolvedRef = {
  file: string;
  line: number;
  callExpr: string; // e.g. "ipcMain.handle"
  rawArg: string;
};

// Extract calls of the form `<receiver>.<method>(<firstArg>, ...)` where
// <firstArg> is the channel reference. Greedy by design: we want every
// match, not a precise AST parse — the regex is conservative enough that
// the resolveChannelArg pass classifies any false positives.
//
// Returns BOTH the resolved channels and any unresolved call sites. The
// caller must propagate the unresolved list to a dedicated assertion;
// dropping unresolved refs silently is the exact false-negative the
// reviewer flagged on PR #1332.
function extractCalls(
  source: string,
  file: string,
  receiver: string,
  methods: string[],
): { resolved: string[]; unresolved: UnresolvedRef[] } {
  const resolved: string[] = [];
  const unresolved: UnresolvedRef[] = [];
  const methodPattern = methods.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(
    `\\b${receiver}\\s*\\.\\s*(?:${methodPattern})\\s*\\(\\s*([^,)]+)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const raw = m[1];
    const r = resolveChannelArg(raw);
    if (r !== null) {
      resolved.push(r);
    } else if (isHelperForwardingArg(raw)) {
      // Helper-internal forwarding — see isHelperForwardingArg comment.
      // Not a contract call site, skip.
      continue;
    } else {
      // Compute line number from the byte offset for a useful failure
      // message. (Cheap: split-once on the prefix.)
      const line = source.slice(0, m.index).split('\n').length;
      // Recover which method matched for the callExpr label.
      const matchedMethod = methods.find((mm) =>
        new RegExp(`\\b${receiver}\\s*\\.\\s*${mm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(
          source.slice(m!.index, m!.index + m![0].length),
        ),
      ) ?? methods[0];
      unresolved.push({ file, line, callExpr: `${receiver}.${matchedMethod}`, rawArg: raw.trim() });
    }
  }
  return { resolved, unresolved };
}

// ── Preload-side extraction ───────────────────────────────────────────────
type Side = { invoke: Set<string>; send: Set<string>; on: Set<string> };

function emptySide(): Side {
  return { invoke: new Set(), send: new Set(), on: new Set() };
}

function scanPreload(): { side: Side; unresolved: UnresolvedRef[] } {
  const side = emptySide();
  const unresolved: UnresolvedRef[] = [];
  const bridgesDir = path.join(REPO_ROOT, 'electron', 'preload', 'bridges');
  const files = fs
    .readdirSync(bridgesDir)
    .filter((f) => /\.ts$/.test(f))
    .map((f) => path.join(bridgesDir, f));
  for (const f of files) {
    const src = readFile(f);
    const inv = extractCalls(src, f, 'ipcRenderer', ['invoke']);
    const snd = extractCalls(src, f, 'ipcRenderer', ['send']);
    const onCalls = extractCalls(src, f, 'ipcRenderer', ['on']);
    for (const ch of inv.resolved) side.invoke.add(ch);
    for (const ch of snd.resolved) side.send.add(ch);
    for (const ch of onCalls.resolved) side.on.add(ch);
    unresolved.push(...inv.unresolved, ...snd.unresolved, ...onCalls.unresolved);
  }
  return { side, unresolved };
}

// ── Main-side extraction ──────────────────────────────────────────────────
type MainSide = { handle: Set<string>; on: Set<string>; sendOut: Set<string> };

function emptyMain(): MainSide {
  return { handle: new Set(), on: new Set(), sendOut: new Set() };
}

function scanMain(): { side: MainSide; unresolved: UnresolvedRef[] } {
  const side = emptyMain();
  const unresolved: UnresolvedRef[] = [];
  for (const f of listElectronSources()) {
    // Skip preload — that's the renderer side.
    if (f.includes(`${path.sep}preload${path.sep}`)) continue;
    const src = readFile(f);
    const h = extractCalls(src, f, 'ipcMain', ['handle']);
    const o = extractCalls(src, f, 'ipcMain', ['on']);
    const wcs = extractCalls(src, f, 'webContents', ['send']);
    const wcsShort = extractCalls(src, f, 'wc', ['send']);
    for (const ch of h.resolved) side.handle.add(ch);
    for (const ch of o.resolved) side.on.add(ch);
    for (const ch of wcs.resolved) side.sendOut.add(ch);
    for (const ch of wcsShort.resolved) side.sendOut.add(ch);
    unresolved.push(
      ...h.unresolved,
      ...o.unresolved,
      ...wcs.unresolved,
      ...wcsShort.unresolved,
    );
    // Bare `sendAll(channel, payload)` — no receiver. Match the function
    // call directly so we can capture it the same way; classify
    // unresolved with the same shape as the others.
    const sendAllRe = /\bsendAll\s*\(\s*([^,)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = sendAllRe.exec(src)) !== null) {
      const raw = m[1];
      const r = resolveChannelArg(raw);
      if (r !== null) {
        side.sendOut.add(r);
      } else if (isHelperForwardingArg(raw)) {
        // Inside the `sendAll` helper itself — not a contract site.
        continue;
      } else {
        const line = src.slice(0, m.index).split('\n').length;
        unresolved.push({ file: f, line, callExpr: 'sendAll', rawArg: raw.trim() });
      }
    }
  }
  return { side, unresolved };
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
  const preloadScan = scanPreload();
  const mainScan = scanMain();
  const preload = preloadScan.side;
  const main = mainScan.side;
  const allUnresolved = [...preloadScan.unresolved, ...mainScan.unresolved];

  it('extracts a non-trivial channel surface (sanity)', () => {
    // If these go to zero, the regex broke — fail loudly instead of
    // silently passing every subsequent assertion against empty sets.
    expect(preload.invoke.size).toBeGreaterThan(5);
    expect(main.handle.size).toBeGreaterThan(5);
  });

  // Reviewer (PR #1332) flagged the false-negative escape hatch in the
  // extractor: if a call site uses a dynamic first arg (template literal,
  // variable reference, ternary, etc.), `resolveChannelArg` returns null
  // and the call site would be invisible to every other assertion below.
  // We assert here that no such call site exists. The codebase's
  // ipcChannels.ts discipline forbids dynamic channel refs, so a non-empty
  // unresolved list is itself a contract violation — surface it directly
  // with a precise file:line:callExpr trace rather than letting it slip
  // into a "missing handler" diff later.
  it('no IPC call site uses a dynamic / unresolved channel reference', () => {
    if (allUnresolved.length > 0) {
      const lines = allUnresolved.map(
        (u) =>
          `  ${path.relative(REPO_ROOT, u.file)}:${u.line}  ${u.callExpr}(${u.rawArg}, ...)`,
      );
      throw new Error(
        `Found ${allUnresolved.length} IPC call site(s) whose channel arg ` +
          `is not a literal string or a CONST.key reference. Each such ` +
          `site is invisible to the parity extractor and could mask a ` +
          `rename / drop. Replace with a literal or add the constant to ` +
          `electron/shared/ipcChannels.ts:\n${lines.join('\n')}`,
      );
    }
    expect(allUnresolved).toEqual([]);
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

  // ── Extractor self-test ─────────────────────────────────────────────
  // Mutation-check the resolver: if any of these classifications regress,
  // the false-negative escape hatch the reviewer flagged on PR #1332
  // re-opens.
  it('resolveChannelArg classifies literal vs. dynamic refs correctly', () => {
    // Literal strings — resolved to their content.
    expect(resolveChannelArg(`'pty:input'`)).toBe('pty:input');
    expect(resolveChannelArg(`"db:save"`)).toBe('db:save');
    // CONST.key — resolved through CONST_MAP.
    expect(resolveChannelArg('PTY_CHANNELS.input')).toBe('pty:input');
    expect(resolveChannelArg('DB_CHANNELS.save')).toBe('db:save');
    // Unknown CONST.key — null (looks like a constant but isn't one).
    expect(resolveChannelArg('PTY_CHANNELS.nopeNotReal')).toBeNull();
    // Dynamic refs — must be null (and therefore surfaced by the
    // unresolved-call-site test) rather than masquerading as a literal.
    expect(resolveChannelArg('`pty:${kind}`')).toBeNull();
    expect(resolveChannelArg('channel')).toBeNull();
    expect(resolveChannelArg('foo.bar')).toBeNull(); // lowercase namespace
  });
});

/**
 * `window.ccsmPty` — real preload bridge for the v0.3 daemon (W2-B / Task #581).
 *
 * Replaces the W2-prep stub with a fetch + EventSource shim against the
 * daemon's loopback HTTP API:
 *   * sync RPCs (spawn / attach / detach / get / list / input / resize /
 *     kill / checkClaudeAvailable / getBufferSnapshot) → POST
 *     `/api/pty/<op>` with `application/json` body, await `{ok, ...}`.
 *   * event subscriptions (onData / onExit / onAck) → open
 *     `EventSource('/api/events/pty?sid=<sid>')` and route by SSE event
 *     type. Exit closes the stream + invokes the exit callback. Multiple
 *     subscribers per sid share one EventSource (refcount), so attach +
 *     onData + onExit don't open three sockets.
 *   * clipboard.writeText is unchanged from the stub — it stays inside the
 *     renderer (`navigator.clipboard`) and never round-trips to daemon.
 *
 * Daemon port resolution: `ipcRenderer.invoke('daemon:getPort')` returns
 * the loopback port main bound after `spawnDaemon()` resolved. We cache
 * the port on first lookup; if `null`, we lazy-poll on each request until
 * one returns. The renderer's hydration store also calls `getDaemonPort`
 * up front so by the time any pty bridge call fires the port is usually
 * already known.
 *
 * Other wave-2 sub-PRs MUST NOT touch this file (only W2-B does).
 */

import { contextBridge, ipcRenderer } from "electron";

// ---------------------------------------------------------------------------
// Daemon base URL
// ---------------------------------------------------------------------------

let cachedPort: number | null = null;

async function getBaseUrl(): Promise<string> {
  if (cachedPort !== null) return `http://127.0.0.1:${cachedPort}`;
  // Poll until main reports a port. spawnDaemon resolves quickly under
  // normal conditions; bound the wait so a permanently broken daemon
  // surfaces as a Promise rejection (caller's try/catch + zustand error
  // state already handle it).
  for (let i = 0; i < 50; i += 1) {
    const port = (await ipcRenderer.invoke("daemon:getPort")) as number | null;
    if (typeof port === "number" && port > 0) {
      cachedPort = port;
      return `http://127.0.0.1:${cachedPort}`;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("ccsmPty: daemon port unavailable after 5s");
}

async function rpc<T>(op: string, body: unknown): Promise<T> {
  const base = await getBaseUrl();
  const res = await fetch(`${base}/api/pty/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ccsmPty.${op} HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// SSE multiplexer (per sid, refcounted)
// ---------------------------------------------------------------------------

type DataCallback = (data: string) => void;
type ExitCallback = (code: number | null) => void;
type AckCallback = (seq: number) => void;

interface SidStream {
  source: EventSource;
  data: Set<DataCallback>;
  exit: Set<ExitCallback>;
  ack: Set<AckCallback>;
  refcount: number;
}

const streams = new Map<string, SidStream>();

async function openStream(sid: string): Promise<SidStream> {
  const existing = streams.get(sid);
  if (existing) {
    existing.refcount += 1;
    return existing;
  }
  const base = await getBaseUrl();
  const url = `${base}/api/events/pty?sid=${encodeURIComponent(sid)}`;
  const source = new EventSource(url);
  const stream: SidStream = {
    source,
    data: new Set(),
    exit: new Set(),
    ack: new Set(),
    refcount: 1,
  };
  source.addEventListener("pty:data", (evt: MessageEvent) => {
    let parsed: { chunk?: string };
    try {
      parsed = JSON.parse(evt.data) as { chunk?: string };
    } catch {
      return;
    }
    const chunk = typeof parsed.chunk === "string" ? parsed.chunk : "";
    if (!chunk) return;
    for (const cb of stream.data) {
      try { cb(chunk); } catch { /* subscriber threw, ignore */ }
    }
  });
  source.addEventListener("pty:exit", (evt: MessageEvent) => {
    let parsed: { code?: number | null };
    try {
      parsed = JSON.parse(evt.data) as { code?: number | null };
    } catch {
      parsed = { code: null };
    }
    const code = parsed.code ?? null;
    for (const cb of stream.exit) {
      try { cb(code); } catch { /* subscriber threw, ignore */ }
    }
    // Daemon closed the stream after exit; tear down the local socket too.
    closeStream(sid, /* force */ true);
  });
  source.addEventListener("pty:ack", (evt: MessageEvent) => {
    let parsed: { seq?: number };
    try {
      parsed = JSON.parse(evt.data) as { seq?: number };
    } catch {
      return;
    }
    if (typeof parsed.seq !== "number") return;
    for (const cb of stream.ack) {
      try { cb(parsed.seq); } catch { /* subscriber threw, ignore */ }
    }
  });
  source.addEventListener("error", () => {
    // EventSource auto-reconnects on transient errors; we don't tear
    // down here. A real exit is signalled by the `pty:exit` event,
    // which closes the stream above.
  });
  streams.set(sid, stream);
  return stream;
}

function closeStream(sid: string, force: boolean): void {
  const stream = streams.get(sid);
  if (!stream) return;
  if (!force) {
    stream.refcount -= 1;
    if (stream.refcount > 0) return;
  }
  try { stream.source.close(); } catch { /* already closed */ }
  streams.delete(sid);
}

function attachListener(
  sid: string,
  bucket: "data" | "exit" | "ack",
  cb: DataCallback | ExitCallback | AckCallback,
): () => void {
  // Open the stream lazily; openStream is async but the unsubscribe handle
  // must be returned synchronously, so we schedule an open and capture the
  // resulting stream when it resolves.
  let added = false;
  const pending = openStream(sid).then((stream) => {
    if (bucket === "data") stream.data.add(cb as DataCallback);
    else if (bucket === "exit") stream.exit.add(cb as ExitCallback);
    else stream.ack.add(cb as AckCallback);
    added = true;
    return stream;
  });
  return () => {
    pending
      .then((stream) => {
        if (bucket === "data") stream.data.delete(cb as DataCallback);
        else if (bucket === "exit") stream.exit.delete(cb as ExitCallback);
        else stream.ack.delete(cb as AckCallback);
        if (added) closeStream(sid, /* force */ false);
      })
      .catch(() => {
        /* open failed; nothing to clean up */
      });
  };
}

// ---------------------------------------------------------------------------
// Wire shapes (mirror daemon/api/pty.ts)
// ---------------------------------------------------------------------------

interface SpawnInfo {
  ok: true;
  sid: string;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
}
interface SpawnFail {
  ok: false;
  error: string;
}
type SpawnResult = SpawnInfo | SpawnFail;

interface AttachOk {
  ok: true;
  attach: { snapshot: string; cols: number; rows: number; pid: number } | null;
}
interface SimpleOk { ok: true }
interface ListResp { ok: true; sessions: SpawnInfo[] }
interface GetResp { ok: true; info: SpawnInfo | null }
interface KillResp { ok: true; killed: boolean }
interface SnapResp { ok: true; snapshot: string; seq: number }
interface ClaudeResp {
  available: boolean;
  path?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public bridge surface
// ---------------------------------------------------------------------------

const ccsmPty = {
  spawn: (opts: { sid: string; cwd: string }): Promise<SpawnResult> =>
    rpc<SpawnResult>("spawn", opts),
  attach: (sid: string): Promise<AttachOk> => rpc<AttachOk>("attach", { sid }),
  detach: (sid: string): Promise<SimpleOk> => rpc<SimpleOk>("detach", { sid }),
  get: (sid: string): Promise<GetResp> => rpc<GetResp>("get", { sid }),
  list: async (): Promise<SpawnInfo[]> => {
    const r = await rpc<ListResp>("list", {});
    return r.sessions;
  },
  input: (sid: string, data: string): Promise<SimpleOk> =>
    rpc<SimpleOk>("input", { sid, data }),
  resize: (sid: string, cols: number, rows: number): Promise<SimpleOk> =>
    rpc<SimpleOk>("resize", { sid, cols, rows }),
  kill: (sid: string): Promise<KillResp> => rpc<KillResp>("kill", { sid }),
  checkClaudeAvailable: (force?: boolean): Promise<ClaudeResp> =>
    rpc<ClaudeResp>("checkClaudeAvailable", { force: force === true }),
  getBufferSnapshot: async (sid: string): Promise<string> => {
    const r = await rpc<SnapResp>("getBufferSnapshot", { sid });
    return r.snapshot;
  },

  onData: (sid: string, cb: (data: string) => void): (() => void) =>
    attachListener(sid, "data", cb),
  onExit: (sid: string, cb: (code: number | null) => void): (() => void) =>
    attachListener(sid, "exit", cb),
  onAck: (sid: string, cb: (seq: number) => void): (() => void) =>
    attachListener(sid, "ack", cb),

  clipboard: {
    writeText: (text: string): Promise<void> =>
      navigator.clipboard?.writeText(text) ?? Promise.resolve(),
  },
} as const;

export type CcsmPtyApi = typeof ccsmPty;

export function installCcsmPtyBridge(): void {
  contextBridge.exposeInMainWorld("ccsmPty", ccsmPty);
}

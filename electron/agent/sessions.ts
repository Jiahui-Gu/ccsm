import os from 'node:os';
import path from 'node:path';
import { spawnClaude, type ClaudeProcess, type PermissionMode as CliPermissionMode } from './claude-spawner';
import { splitNDJSON } from './ndjson-splitter';
import { parseStreamJSONLine } from './stream-json-parser';
import type { ClaudeStreamEvent } from './stream-json-types';
import {
  ControlRpc,
  type CanUseToolContext,
  type CanUseToolDecision,
  type ParsedStreamEvent,
} from './control-rpc';

// Permission mode accepted across the IPC boundary. Values match the CLI's
// `--permission-mode` flag 1:1 — the renderer's `PermissionMode` enum is
// already aligned, so no translation is needed.
//
// We still accept legacy UI-only modes (`'dontAsk'`, `'auto'`, and the older
// `'ask'` / `'yolo'` / `'standard'`) here so an older renderer build doesn't
// break the spawner. Unknown values coerce to `'default'` in
// `toCliPermissionMode` below.
export type PermissionMode =
  | CliPermissionMode
  | 'dontAsk'
  | 'auto'
  | 'ask'
  | 'yolo'
  | 'standard';

// IPC payload mirrors the on-wire stream-json events from claude.exe stdout.
export type AgentMessage = ClaudeStreamEvent;

function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}

/**
 * claude.exe refuses to run without `CLAUDE_CONFIG_DIR` (claude-spawner enforces
 * this). main.ts hasn't been migrated to pass an explicit configDir yet — that's
 * batch 3. For now we accept it via StartOptions, fall back to the env override,
 * and finally to a stable per-user dir under the home directory so the user's
 * own ~/.claude is never touched.
 */
function resolveConfigDir(explicit: string | undefined): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const env = process.env.AGENTORY_CLAUDE_CONFIG_DIR;
  if (env && env.trim().length > 0) return env;
  return path.join(os.homedir(), '.agentory', 'claude-cli-config');
}

/**
 * Coerce any incoming permission mode to a CLI-accepted value. Handles:
 *   - current UI enum (already CLI-aligned): passes through
 *   - legacy UI aliases (`ask` → `default`, `yolo` → `bypassPermissions`, ...)
 *   - SDK-only literals (`dontAsk` → `default`, `auto` → `acceptEdits`*)
 *     *Note: the CLI's real classifier-driven `auto` mode is NOT accepted
 *     here by design — we never surface it in the UI, so an `auto` on the
 *     wire must be our legacy alias for `acceptEdits`.
 * Unknown strings coerce to `'default'` rather than passing an invalid flag
 * value to claude.exe.
 */
function toCliPermissionMode(mode: PermissionMode | undefined): CliPermissionMode | undefined {
  if (!mode) return undefined;
  switch (mode) {
    case 'default':
    case 'acceptEdits':
    case 'plan':
    case 'bypassPermissions':
      return mode;
    case 'ask':
    case 'standard':
    case 'dontAsk':
      return 'default';
    case 'auto':
      return 'acceptEdits';
    case 'yolo':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

export type StartOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  apiKey?: string;
  resumeSessionId?: string;
  /**
   * Per-session env overrides layered onto the spawner's SAFE_ENV baseline
   * BEFORE `apiKey` is applied. Used to pipe an endpoint's ANTHROPIC_BASE_URL
   * + ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN into the child so each session
   * can target a different endpoint.
   */
  envOverrides?: Record<string, string>;
  /**
   * Optional override for `CLAUDE_CONFIG_DIR`. main.ts currently doesn't pass
   * one — see resolveConfigDir() for the fallback chain. Will become required
   * once main.ts is migrated (batch 3, T9).
   */
  configDir?: string;
};

export type EventHandler = (msg: AgentMessage) => void;
export type ExitHandler = (info: { error?: string }) => void;
export type PermissionRequestHandler = (req: {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => void;

export class SessionRunner {
  private cp: ClaudeProcess | null = null;
  private rpc: ControlRpc | null = null;
  private abort: AbortController | null = null;
  private consumer: Promise<void> | null = null;
  private disposed = false;
  private cliSessionId: string | undefined;
  private permissionMode: PermissionMode = 'default';
  /**
   * Pending can_use_tool decisions, keyed by the synthetic requestId we hand
   * to the renderer. resolvePermission() looks the entry up to settle the
   * promise that ControlRpc is awaiting before it writes the control_response.
   */
  private pendingPerms = new Map<string, (d: CanUseToolDecision) => void>();
  private nextPermSeq = 0;

  constructor(
    public readonly id: string,
    private readonly onEvent: EventHandler,
    private readonly onExit: ExitHandler,
    private readonly onPermissionRequest: PermissionRequestHandler
  ) {}

  resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean {
    const resolve = this.pendingPerms.get(requestId);
    if (!resolve) return false;
    this.pendingPerms.delete(requestId);
    resolve(
      decision === 'allow'
        ? { allow: true }
        : { allow: false, deny_reason: 'User denied tool use.' }
    );
    return true;
  }

  async start(opts: StartOptions): Promise<void> {
    if (this.cp) return;
    this.permissionMode = opts.permissionMode ?? 'default';
    this.abort = new AbortController();

    const envOverrides: Record<string, string> = { ...(opts.envOverrides ?? {}) };
    if (opts.apiKey) envOverrides.ANTHROPIC_API_KEY = opts.apiKey;

    this.cp = await spawnClaude({
      cwd: resolveCwd(opts.cwd),
      configDir: resolveConfigDir(opts.configDir),
      permissionMode: toCliPermissionMode(this.permissionMode),
      model: opts.model,
      resumeId: opts.resumeSessionId,
      envOverrides,
      signal: this.abort.signal,
    });

    this.rpc = new ControlRpc(this.cp.stdin, {
      onCanUseTool: (toolName, input, ctx) => this.handleCanUseTool(toolName, input, ctx),
    });

    const stdout = this.cp.stdout;
    const cp = this.cp;
    this.consumer = (async () => {
      try {
        for await (const ev of splitNDJSON(stdout)) {
          if (this.disposed) break;
          if (ev.type === 'error') {
            // Splitter errors (line cap exceeded, incomplete UTF-8 at EOF). Log
            // via console — the renderer doesn't have a channel for these and
            // they're rare protocol-violation diagnostics, not user-facing.
            console.warn('[sessions] ndjson splitter error', ev.error.message);
            continue;
          }
          this.handleLine(ev.raw);
        }
        const { code, signal } = await cp.wait();
        const err = code === 0 || code === null
          ? undefined
          : `claude.exe exited with code=${code}${signal ? ` signal=${signal}` : ''}` +
            (cp.getRecentStderr() ? `\n${cp.getRecentStderr()}` : '');
        this.onExit({ error: err });
      } catch (err) {
        this.onExit({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.cleanupAfterExit();
      }
    })();
  }

  private handleLine(raw: string): void {
    const result = parseStreamJSONLine(raw);
    if (result.type === 'parse-error') {
      console.warn('[sessions] failed to parse stream-json line', result.error.message);
      return;
    }
    if (result.type === 'unknown') {
      console.warn('[sessions] unknown stream-json frame', result.reason);
      return;
    }
    const event = result.event;
    // Capture cliSessionId from the first system frame so subsequent user
    // messages can carry it.
    if (event.type === 'system' && (event as { subtype?: string }).subtype === 'init') {
      const sid = (event as { session_id?: string }).session_id;
      if (sid && !this.cliSessionId) this.cliSessionId = sid;
    }
    if (
      event.type === 'control_request' ||
      event.type === 'control_response' ||
      event.type === 'control_cancel_request'
    ) {
      this.rpc?.handleIncoming(event as unknown as ParsedStreamEvent);
      return;
    }
    // Forward everything else to the consumer as a typed stream-json event.
    // The renderer's stream-to-blocks consumes this directly.
    this.onEvent(event);
  }

  private handleCanUseTool(
    toolName: string,
    input: unknown,
    ctx: CanUseToolContext
  ): Promise<CanUseToolDecision> {
    return new Promise<CanUseToolDecision>((resolve) => {
      const requestId = `perm-${Date.now().toString(36)}-${(this.nextPermSeq++).toString(36)}`;
      this.pendingPerms.set(requestId, resolve);
      // If claude.exe cancels the request mid-flight, fail-closed via the
      // signal so we don't leak the pending entry.
      ctx.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingPerms.delete(requestId)) {
            resolve({ allow: false, deny_reason: 'Permission request cancelled.' });
          }
        },
        { once: true }
      );
      const safeInput =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : { value: input };
      this.onPermissionRequest({ requestId, toolName, input: safeInput });
    });
  }

  send(text: string): void {
    if (!this.rpc || this.disposed) return;
    try {
      this.rpc.sendUserMessage(text, this.cliSessionId);
    } catch (err) {
      console.warn('[sessions] sendUserMessage failed', err);
    }
  }

  /**
   * Send a user message carrying a prebuilt Anthropic content-block array
   * (e.g. text + image blocks). Image drop/paste flows route through here
   * instead of `send(text)`.
   */
  sendContent(content: readonly unknown[]): void {
    if (!this.rpc || this.disposed) return;
    try {
      this.rpc.sendUserMessageContent(content, this.cliSessionId);
    } catch (err) {
      console.warn('[sessions] sendUserMessageContent failed', err);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.rpc) return;
    try {
      await this.rpc.interrupt();
    } catch {
      /* timeout / channel broken — let close() handle hard kill */
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.rpc) return;
    this.permissionMode = mode;
    const cliMode = toCliPermissionMode(mode);
    if (!cliMode) return;
    try {
      await this.rpc.setPermissionMode(cliMode);
    } catch {
      /* ignore — claude.exe may not honour mid-session changes for every mode */
    }
  }

  async setModel(model?: string): Promise<void> {
    if (!this.rpc || !model) return;
    try {
      await this.rpc.setModel(model);
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of this.pendingPerms.values()) {
      resolve({ allow: false, deny_reason: 'Session closed.' });
    }
    this.pendingPerms.clear();
    this.rpc?.close();
    try {
      this.cp?.stdin.end();
    } catch {
      /* ignore */
    }
    // Trigger SIGTERM → SIGKILL via the abort signal the spawner is watching.
    this.abort?.abort();
  }

  private cleanupAfterExit(): void {
    this.disposed = true;
    for (const resolve of this.pendingPerms.values()) {
      resolve({ allow: false, deny_reason: 'Session ended.' });
    }
    this.pendingPerms.clear();
    this.rpc?.close();
    this.rpc = null;
    this.cp = null;
  }
}

// Re-export for tests that want to assert on the parsed event shape.
export type { ClaudeStreamEvent };

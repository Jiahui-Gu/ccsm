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

export function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}

/**
 * claude.exe refuses to run without `CLAUDE_CONFIG_DIR` (claude-spawner enforces
 * this). Agentory deliberately points it at the user's real `~/.claude/` so we
 * share state (login tokens, settings.json with relay-mode credentials, MCP
 * config) with the user's existing CLI install. Boundary: "if `claude` works in
 * your terminal, Agentory works." Sessions still register in Agentory's own DB —
 * only the claude CLI config dir is shared.
 *
 * Callers may still pass an explicit `configDir` (e.g. tests) or override via
 * the `AGENTORY_CLAUDE_CONFIG_DIR` env var for special-case isolation.
 */
function resolveClaudeConfigDir(explicit: string | undefined): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const env = process.env.AGENTORY_CLAUDE_CONFIG_DIR;
  if (env && env.trim().length > 0) return env;
  return path.join(os.homedir(), '.claude');
}

/**
 * Coerce any incoming permission mode to a CLI-accepted value. Handles:
 *   - current UI enum (already CLI-aligned): passes through
 *   - legacy UI aliases (`ask` → `default`, `yolo` → `bypassPermissions`, ...)
 *   - SDK-only literals (`dontAsk` → `default`, `auto` → `acceptEdits`*)
 *     *Note: the CLI's real classifier-driven `auto` mode is NOT accepted
 *     here by design — we never surface it in the UI, so an `auto` on the
 *     wire must be our legacy alias for `acceptEdits`.
 *
 * Unknown strings THROW. Earlier behaviour silently coerced anything we
 * didn't recognise to `'default'`, which meant a buggy renderer (or a
 * compromised one) could downgrade `bypassPermissions` to `default` by
 * sending a typo and never see an error. The agent:setPermissionMode IPC
 * handler in main.ts catches this and surfaces `{ ok: false, error:
 * 'unknown_mode' }` so the renderer can show "this mode isn't supported".
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
      throw new Error(`Unknown permission mode: ${String(mode)}`);
  }
}

export type StartOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  /**
   * Per-session env overrides layered onto the spawner's SAFE_ENV baseline.
   * Used to pipe an endpoint's ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY /
   * ANTHROPIC_AUTH_TOKEN into the child so each session can target a
   * different endpoint.
   */
  envOverrides?: Record<string, string>;
  /**
   * Optional override for `CLAUDE_CONFIG_DIR`. When unset, Agentory uses the
   * user's real `~/.claude/` so login state is shared with the CLI — see
   * resolveClaudeConfigDir() for the full fallback chain.
   */
  configDir?: string;
  /**
   * Pre-resolved claude binary path. When set, the spawner skips PATH lookup.
   * Populated by main.ts from the persisted `claudeBinPath` state (user's
   * "Browse for binary..." pick in the first-run wizard).
   */
  binaryPath?: string;
};

export type EventHandler = (msg: AgentMessage) => void;
export type ExitHandler = (info: { error?: string }) => void;
export type PermissionRequestHandler = (req: {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => void;
/**
 * Transient diagnostics surfaced from the agent layer — things the user may
 * want to see as a toast (init handshake failed, outbound control_request
 * timed out) but which aren't hard session-ending errors. Kept deliberately
 * minimal: `code` is a stable machine-readable key (e.g. `init_failed`,
 * `control_timeout`), `message` is a one-liner suitable for toast copy.
 */
export type DiagnosticHandler = (d: {
  level: 'warn' | 'error';
  code: string;
  message: string;
}) => void;

/**
 * Single shared callback id for the `PreToolUse` hook we register at
 * `initialize` time. The CLI echoes this string back in every
 * `hook_callback` request, letting our control-rpc dispatcher route the
 * call into the host permission UI.
 */
const HOOK_PERMISSION_CALLBACK_ID = 'agentory-permission';

/**
 * Tools whose permission UX is already handled via the legacy `can_use_tool`
 * code path (which the CLI still emits for these specific "ask"-style tools).
 * For these we let the `PreToolUse` hook pass through with `{}` — the CLI
 * then proceeds to fire `can_use_tool`, which routes to handleCanUseTool and
 * the existing renderer treatment (questions UI, plan-approval UI). Surfacing
 * a generic permission prompt for these would double-prompt the user with a
 * less informative dialog.
 */
const HOOK_PASSTHROUGH_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

/**
 * How long we wait, after `spawn()` returns, before declaring the child has
 * "successfully started". If the OS hands us a pid but the child immediately
 * blows up (`error` event for ENOENT/EACCES, or `exit` with non-zero code
 * inside this window), we want to surface that as a typed
 * `CLI_SPAWN_FAILED` instead of a chirpy `{ ok: true }` followed by a silent
 * `agent:exit`. 200ms empirically covers Windows shim + cmd.exe wrap-up
 * while staying well under any user-visible "starting…" budget — the CLI's
 * first stdout frame normally lands in <50ms, so a process still alive at
 * 200ms is overwhelmingly likely to be healthy.
 *
 * Why we *don't* race against "first stdout byte": adding a `'data'`
 * listener to the spawner's stdout pipe puts it into flowing mode and
 * conflicts with the consumer's `for await` async iterator added below.
 * Stderr already has a ring-buffer listener inside the spawner, but adding
 * a parallel timing channel there for a 200ms optimisation isn't worth the
 * second-mover-wins coordination it would add.
 */
const SPAWN_EARLY_FAILURE_WINDOW_MS = 800;

/**
 * Thrown by `SessionRunner.start()` when the child process emits `exit`
 * with a non-zero code (or an `error` event, which the spawner surfaces as
 * exitCode -1) inside the early-failure window. Carries enough context for
 * the renderer to render an actionable banner: a short reason + the tail of
 * whatever the child managed to write to stderr before dying.
 *
 * `manager.start()` translates this into a `{ ok: false, errorCode:
 * 'CLI_SPAWN_FAILED', detail }` IPC reply. The reason for a typed error
 * rather than reshaping `start()`'s return: keeping the happy path
 * void-returning means existing callers (live IPC handler, resume flow,
 * tests) don't have to learn a new sum type, and the manager already has
 * a try/catch that translates `ClaudeNotFoundError` into a structured IPC
 * reply — we slot in alongside it.
 */
export class ClaudeSpawnFailedError extends Error {
  public readonly code = 'CLI_SPAWN_FAILED' as const;
  constructor(
    message: string,
    public readonly detail: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null
  ) {
    super(message);
    this.name = 'ClaudeSpawnFailedError';
  }
}

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
    private readonly onPermissionRequest: PermissionRequestHandler,
    private readonly onDiagnostic: DiagnosticHandler = () => {}
  ) {}

  /** Test-only backdoor: expose the child pid for dev probes. */
  getPid(): number | undefined {
    return this.cp?.pid;
  }

  /**
   * Wait up to `SPAWN_EARLY_FAILURE_WINDOW_MS` for the child to die. Returns
   * the exit info if it did, `null` if the child survived the window
   * (presumed healthy). `cp.wait()` never rejects per the spawner contract;
   * the worst case is we time out and return null, in which case `start()`
   * proceeds with the normal happy path.
   *
   * Note we deliberately do NOT touch stdout — the consumer in `start()`
   * attaches a `for await` reader, and adding a `'data'` listener now would
   * put the stream into flowing mode and race the async iterator. Stderr
   * already has a ring-buffer listener inside the spawner so reading
   * `getRecentStderr()` after we know the child has exited is safe.
   */
  private async detectEarlyFailure(
    cp: ClaudeProcess
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; detail: string } | null> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SPAWN_EARLY_FAILURE_WINDOW_MS);
      timer.unref?.();
    });
    const exitWatcher = cp.wait().then((info) => ({ kind: 'exit' as const, info }));
    const winner = await Promise.race([timeout, exitWatcher]);
    if (timer) clearTimeout(timer);
    if (winner === 'timeout') return null;
    const { code, signal } = winner.info;
    // code === 0 means the CLI ran to completion in <200ms with success
    // status — rare (an immediate `--version`-style argv would do it) but
    // not a failure to surface.
    if (code === 0) return null;
    const stderrTail = cp.getRecentStderr().trim();
    const detail =
      stderrTail.length > 0
        ? stderrTail
        : `claude.exe exited with code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''} and no stderr output.`;
    return { exitCode: code, signal, detail };
  }

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

    this.cp = await spawnClaude({
      cwd: resolveCwd(opts.cwd),
      configDir: resolveClaudeConfigDir(opts.configDir),
      permissionMode: toCliPermissionMode(this.permissionMode),
      model: opts.model,
      resumeId: opts.resumeSessionId,
      envOverrides,
      binaryPath: opts.binaryPath,
      signal: this.abort.signal,
    });

    // Early-failure detection: wait briefly for the child to either prove
    // it's alive (survives the window) or die noisily (`exit` with non-zero
    // code, or libuv `error` event surfaced by the spawner as exitCode=-1).
    // Without this, a CLI that exits immediately — stale binPath, missing
    // dependency, bad shim, etc. — slips through as `{ ok: true }` and the
    // user sees a chat that just never streams. Surfacing as
    // `CLI_SPAWN_FAILED` lets the renderer show the "Agent failed to start"
    // banner with stderr context instead.
    const earlyFailure = await this.detectEarlyFailure(this.cp);
    if (earlyFailure) {
      // Tear the cp down — the child is already gone but kill() is
      // idempotent and ensures the abort listeners + stderr ring are
      // released. Then null out the runner's process refs so a retry can
      // re-spawn cleanly.
      try {
        this.cp.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      this.cp = null;
      this.abort = null;
      throw new ClaudeSpawnFailedError(
        `claude.exe exited immediately after spawn (code=${
          earlyFailure.exitCode ?? 'null'
        }${earlyFailure.signal ? ` signal=${earlyFailure.signal}` : ''})`,
        earlyFailure.detail,
        earlyFailure.exitCode,
        earlyFailure.signal
      );
    }

    this.rpc = new ControlRpc(this.cp.stdin, {
      onCanUseTool: (toolName, input, ctx) => this.handleCanUseTool(toolName, input, ctx),
      onHookCallback: (callbackId, input, signal) =>
        this.handleHookCallback(callbackId, input, signal),
    });

    // Tell claude.exe we're an SDK-style consumer that handles permission
    // decisions over stdio. The CLI 2.x rule engine handles built-in tools
    // (Bash/Write/Edit/...) entirely client-side and never emits
    // `can_use_tool` for them — `--permission-prompt-tool stdio` only kicks in
    // for the small subset of "ask" tools (AskUserQuestion, ExitPlanMode). To
    // restore host-driven permission prompts for the built-in destructive
    // tools, we register a `PreToolUse` hook with matcher `.*` and route the
    // resulting `hook_callback` requests into the same UI flow as
    // `can_use_tool`. The callback id is opaque to the CLI; we use a single
    // shared id so the handler in handleHookCallback is unambiguous. Fire-and-
    // forget — the response carries a `commands` list we don't consume.
    //
    // Failure surfacing: a lost handshake means the CLI falls through to its
    // local rule engine, which is security-relevant (the user may expect
    // prompts that never arrive for edits/writes). We emit `init_failed` as
    // a diagnostic so the renderer can toast — the user should at least know
    // their permission UX is degraded.
    void this.rpc
      .sendControlRequest({
        subtype: 'initialize',
        hooks: {
          PreToolUse: [
            { matcher: '.*', hookCallbackIds: [HOOK_PERMISSION_CALLBACK_ID] },
          ],
        },
      })
      .catch((err) => {
        // Quietly ignore failures during teardown — close() races the
        // initialize round-trip in tests / fast-cancel flows. Only log
        // when we genuinely lost the handshake on a live session.
        if (this.disposed) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[sessions] initialize handshake failed', err);
        this.onDiagnostic({
          level: 'error',
          code: 'init_failed',
          message: `Agent initialize handshake failed — permission prompts may be degraded: ${msg}`,
        });
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

  /**
   * Handle a `PreToolUse` hook_callback from the CLI. The hook fires for
   * every tool invocation (matcher `.*` was registered at initialize time);
   * we use it as the host-side permission gate that `--permission-prompt-tool
   * stdio` no longer reliably provides for built-in tools in CLI 2.x.
   *
   * Decision rules:
   *   - Wrong callback id → `{}` (no-op continue). Defensive — we only ever
   *     register one callback so this should not happen, but a future
   *     extension that registers more hooks should not silently auto-allow.
   *   - `bypassPermissions` mode → continue (the user explicitly asked us
   *     not to prompt).
   *   - `acceptEdits` mode → continue. The CLI itself already auto-accepts
   *     edits in this mode; surfacing a prompt would contradict the mode.
   *   - Tool is in HOOK_PASSTHROUGH_TOOLS → continue. The CLI will then fire
   *     `can_use_tool` for these tools and the existing handler renders the
   *     specialized UI (AskUserQuestion → questions block; ExitPlanMode →
   *     plan-approval block).
   *   - Otherwise → surface to the renderer as a permission prompt and wait
   *     for the user's allow / deny decision.
   *
   * On cancel (signal aborts because the CLI sent `control_cancel_request`
   * or the channel broke), we resolve with `{}` continue — the response is
   * dropped by ControlRpc anyway since the inbound entry is already gone,
   * but cleaning up the pendingPerms entry prevents a leak.
   */
  private handleHookCallback(
    callbackId: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    if (callbackId !== HOOK_PERMISSION_CALLBACK_ID) return Promise.resolve({});

    const payload =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'tool';
    const toolInputRaw = payload.tool_input;
    const toolInput =
      toolInputRaw && typeof toolInputRaw === 'object' && !Array.isArray(toolInputRaw)
        ? (toolInputRaw as Record<string, unknown>)
        : {};
    // The CLI passes the live permission_mode inside the hook payload — we
    // honour that rather than our own cached `this.permissionMode` since a
    // mid-session set_permission_mode could have changed it on either side
    // and the CLI's value is the authoritative one for THIS tool call.
    const liveMode =
      typeof payload.permission_mode === 'string' ? payload.permission_mode : 'default';

    if (liveMode === 'bypassPermissions' || liveMode === 'acceptEdits') {
      return Promise.resolve({});
    }
    if (HOOK_PASSTHROUGH_TOOLS.has(toolName)) return Promise.resolve({});

    return new Promise<unknown>((resolve) => {
      const requestId = `perm-${Date.now().toString(36)}-${(this.nextPermSeq++).toString(36)}`;
      this.pendingPerms.set(requestId, (decision: CanUseToolDecision) => {
        if (decision.allow) {
          resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          });
        } else {
          resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: decision.deny_reason ?? 'User denied tool use.',
            },
          });
        }
      });
      signal.addEventListener(
        'abort',
        () => {
          if (this.pendingPerms.delete(requestId)) {
            // Hook handler is allowed to no-op on cancel — the CLI has
            // already moved on. Don't write a deny here; let it fall through.
            resolve({});
          }
        },
        { once: true }
      );
      this.onPermissionRequest({ requestId, toolName, input: toolInput });
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
    } catch (err) {
      // Timeout / channel broken. close() will escalate via SIGTERM/SIGKILL
      // through the abort signal; the user still deserves a heads-up that
      // the soft interrupt didn't land so a "Stop" click that appears to do
      // nothing gets explained.
      this.onDiagnostic({
        level: 'warn',
        code: 'interrupt_timeout',
        message: `Agent didn't acknowledge interrupt (${
          err instanceof Error ? err.message : String(err)
        }). Force-killing.`,
      });
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Validate up front so a bogus mode is rejected even if the session
    // hasn't started yet (no rpc) — the IPC layer relies on the throw to
    // surface `unknown_mode` to the renderer.
    const cliMode = toCliPermissionMode(mode);
    if (!this.rpc) {
      this.permissionMode = mode;
      return;
    }
    this.permissionMode = mode;
    if (!cliMode) return;
    try {
      await this.rpc.setPermissionMode(cliMode);
    } catch (err) {
      this.onDiagnostic({
        level: 'warn',
        code: 'set_permission_mode_timeout',
        message: `Agent unresponsive to permission-mode change (${
          err instanceof Error ? err.message : String(err)
        }).`,
      });
    }
  }

  async setModel(model?: string): Promise<void> {
    if (!this.rpc || !model) return;
    try {
      await this.rpc.setModel(model);
    } catch (err) {
      this.onDiagnostic({
        level: 'warn',
        code: 'set_model_timeout',
        message: `Agent unresponsive to model change (${
          err instanceof Error ? err.message : String(err)
        }).`,
      });
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
    // Stream listeners attached by the splitter + stderr ring buffer in
    // claude-spawner can outlive the exit (the child's `exit` event fires
    // before its stdio pipes emit `close`). Left dangling they either (a)
    // pin the Readable's internal buffer in memory per-session forever, or
    // (b) fire a late `data` event that races our disposed guard. Explicit
    // teardown: drop listeners first, THEN destroy the streams so any
    // in-flight `data`/`error` from the destroy path doesn't re-invoke a
    // consumer we already nulled out.
    const cp = this.cp;
    if (cp) {
      try {
        cp.stdout.removeAllListeners();
        cp.stdout.destroy();
      } catch {
        /* ignore */
      }
      try {
        cp.stderr.removeAllListeners();
        cp.stderr.destroy();
      } catch {
        /* ignore */
      }
      try {
        cp.stdin.removeAllListeners();
        // stdin was end()'d in close(); destroy() is a cheap idempotent
        // double-check for the abnormal-exit path (consumer loop threw).
        cp.stdin.destroy();
      } catch {
        /* ignore */
      }
    }
    this.cp = null;
  }
}

// Re-export for tests that want to assert on the parsed event shape.
export type { ClaudeStreamEvent };

/**
 * SDK-backed session runner. Implements the same surface as
 * `electron/agent/sessions.ts` SessionRunner so `manager.ts` can swap
 * between them via the `CCSM_USE_SDK` feature flag without changing any
 * other code.
 *
 * Why a separate runner (not a refactor of the existing sessions.ts):
 *   - Lets us A/B-gate the SDK migration on real users via env var. If the
 *     SDK has any behaviour drift (message timing, error semantics, hook
 *     payload shape, interrupt latency) the user can `unset CCSM_USE_SDK`
 *     and immediately fall back to the proven hand-written wrapper.
 *   - Forces us to make the contract between manager.ts and a runner
 *     explicit (it's the duck-typed surface used in createRunner below).
 *     The old runner's interface previously only existed implicitly inside
 *     manager.ts.
 *   - Once the SDK path is validated in dogfood, the cutover is a one-line
 *     manager.ts change (drop the flag) plus deletion of the legacy code —
 *     not a half-merged refactor.
 *
 * What this runner deliberately does NOT do (kept consistent with the legacy
 * runner so this PR is behaviour-equivalent under the flag):
 *   - Per-tool cancel: still falls back to a turn-level interrupt because the
 *     SDK control surface has no scoped cancel today (mirrors the rationale
 *     in sessions.ts cancelToolUse).
 *   - Explicit sessionId management (UUID v4 via SDK's `sessionId` option):
 *     PR-D wires this up — the renderer pre-allocates a UUID at session
 *     create time and passes it through StartOptions.sessionId so the SDK
 *     uses it as the CLI's `session_id`. The captured cliSessionId from the
 *     first system init frame is asserted to match (diagnostic on drift).
 *   - Bundled binary: PR-A still resolves the user's system claude binary
 *     via binary-resolver and passes it through `pathToClaudeCodeExecutable`.
 *     PR-B will swap in the SDK-bundled binary.
 */

import os from 'node:os';
import path from 'node:path';
import { resolveClaudeInvocation, ClaudeNotFoundError } from '../agent/binary-resolver';
import type {
  StartOptions,
  PermissionMode,
  EventHandler,
  ExitHandler,
  PermissionRequestHandler,
  DiagnosticHandler,
  AgentMessage,
} from '../agent/sessions';
import { translateSdkMessage, type SdkMessageLike } from './sdk-message-translator';

export type { StartOptions, PermissionMode, EventHandler, ExitHandler };

// Re-export so the manager-side import in createRunner type-checks against the
// same shape the legacy runner uses.
export type { AgentMessage };

/**
 * `CanUseToolDecision` mirrors the shape from `electron/agent/control-rpc.ts`
 * — see partial-write integration in resolvePermissionPartial below. We
 * redefine it locally rather than importing to keep the SDK runner free of
 * any control-rpc dependency (control-rpc is the legacy code path).
 */
type CanUseToolDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; deny_reason?: string };

import { filterToolInputByAcceptedHunks } from '../agent/partial-write';

/**
 * Resolve `~`-prefixed paths the way the legacy runner does. Kept identical
 * (not factored into a shared util) because we don't want PR-A touching any
 * file outside electron/agent-sdk/.
 */
function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    return path.join(os.homedir(), cwd.slice(2));
  }
  return cwd;
}

function resolveClaudeConfigDir(explicit: string | undefined): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const env = process.env.CCSM_CLAUDE_CONFIG_DIR;
  if (env && env.trim().length > 0) return env;
  return path.join(os.homedir(), '.claude');
}

/**
 * Coerce ccsm's superset of permission modes (which still carries legacy UI
 * aliases like 'yolo' / 'ask') into the strict SDK mode. Throws on
 * unknown values — the manager.ts catch translates that into `unknown_mode`
 * for the renderer.
 *
 * `auto` is passed through to the SDK (research-preview; the SDK will reject
 * with an error if the current account/model doesn't support it — the
 * renderer catches `{ ok:false }` and falls back to `default`).
 */
function toSdkPermissionMode(
  mode: PermissionMode | undefined,
): 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | undefined {
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
      // Forward 'auto' to the SDK as-is. The SDK's PermissionMode type is
      // narrower than the CLI's `--permission-mode` flag (which accepts
      // 'auto'); cast through unknown rather than widening the return type
      // so the rest of this module keeps the strict 4-value contract for
      // the SessionStartOptions path.
      return 'auto' as unknown as 'acceptEdits';
    case 'yolo':
      return 'bypassPermissions';
    default:
      throw new Error(`Unknown permission mode: ${String(mode)}`);
  }
}

/**
 * Build the env passed to the SDK-spawned subprocess. Mirrors
 * `electron/agent/claude-spawner.ts` buildSpawnEnv exactly: deny-by-default
 * baseline, layer required values (CLAUDE_CONFIG_DIR + CLAUDE_CODE_ENTRYPOINT),
 * apply overrides last, then strip Electron poisons.
 *
 * NOTE: we duplicate the SAFE_ENV logic (instead of importing from
 * claude-spawner) because the file-boundary rule for PR-A says we can't
 * reach into electron/agent/ for anything beyond binary-resolver +
 * partial-write. Once PR-B lands and the legacy path is removed, this can
 * collapse back into a shared module.
 */
function buildSdkEnv(opts: {
  configDir: string;
  envOverrides?: Record<string, string>;
}): Record<string, string> {
  // Allowlist mirrors claude-spawner.ts SAFE_ENV. Kept narrow so smuggled
  // shell vars from the Electron parent (NODE_OPTIONS, ELECTRON_RUN_AS_NODE,
  // etc.) never reach the child.
  const SAFE_EXACT = new Set([
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'COMSPEC',
    'PATHEXT',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'COLORTERM',
    'TERM',
  ]);
  const SAFE_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CCSM_', 'AWS_', 'GOOGLE_', 'GCLOUD_', 'XDG_'];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (SAFE_EXACT.has(k.toUpperCase()) || SAFE_PREFIXES.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }
  env.CLAUDE_CONFIG_DIR = opts.configDir;
  env.CLAUDE_CODE_ENTRYPOINT = 'ccsm-desktop';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'ccsm-desktop/0.1.0';
  if (opts.envOverrides) {
    for (const [k, v] of Object.entries(opts.envOverrides)) {
      env[k] = v;
    }
  }
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Tools whose permission UX is owned by the renderer's question / plan UI —
 * the SDK runner must not surface a generic permission prompt for these.
 * Mirrors HOOK_PASSTHROUGH_TOOLS in the legacy runner.
 */
const PASSTHROUGH_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

// Module-level handle to the dynamically-loaded SDK. Lazy-loaded the first
// time start() runs so unit tests that don't exercise start() can run without
// the SDK on the require path. We never re-import — once loaded the handle is
// reused across sessions.
let sdkModulePromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null;
function loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!sdkModulePromise) {
    // Use Function-eval so TS's CommonJS down-level doesn't rewrite this
    // dynamic `import()` into `require()` — the SDK ships ESM-only and
    // Electron 33 (Node 20) lacks require(esm) support, so the require()
    // form throws ERR_REQUIRE_ESM at runtime. Same pattern as electron/notify.ts.
    sdkModulePromise = (
      Function('m', 'return import(m)') as (m: string) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>
    )('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModulePromise;
}

/**
 * Test seam: lets unit tests inject a fake SDK module without going through
 * the real ESM import. Production code never calls this.
 */
export function __setSdkModuleForTests(
  mod: typeof import('@anthropic-ai/claude-agent-sdk') | null,
): void {
  sdkModulePromise = mod ? Promise.resolve(mod) : null;
}

export class SdkSessionRunner {
  private query: import('@anthropic-ai/claude-agent-sdk').Query | null = null;
  private abort: AbortController | null = null;
  private consumer: Promise<void> | null = null;
  private disposed = false;
  private cliSessionId: string | undefined;
  private permissionMode: PermissionMode = 'default';

  /**
   * Outbound user-message queue. The SDK consumes user input via an
   * AsyncIterable<SDKUserMessage> we hand to `query({ prompt })`. We push
   * messages onto this queue from `send()` / `sendContent()` and the
   * iterator yields them.
   */
  private inputQueue: Array<{
    role: 'user';
    content: string | readonly unknown[];
  }> = [];
  private inputResolve: ((v: void) => void) | null = null;
  private inputClosed = false;

  /**
   * Pending permission decisions, keyed by a synthetic requestId. The SDK's
   * `canUseTool` callback awaits the matching entry's resolve(); the
   * renderer settles it via resolvePermission / resolvePermissionPartial.
   */
  private pendingPerms = new Map<
    string,
    {
      resolve: (d: CanUseToolDecision) => void;
      toolName: string;
      input: unknown;
    }
  >();
  private nextPermSeq = 0;

  constructor(
    public readonly id: string,
    private readonly onEvent: EventHandler,
    private readonly onExit: ExitHandler,
    private readonly onPermissionRequest: PermissionRequestHandler,
    private readonly onDiagnostic: DiagnosticHandler = () => {},
  ) {}

  /**
   * Mirrors SessionRunner.getPid() but the SDK doesn't expose the child pid
   * today. Returns undefined so dev probes degrade gracefully (the assertion
   * "runner exists" still passes, the pid sub-assertion just sees undefined).
   */
  getPid(): number | undefined {
    return undefined;
  }

  resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pendingPerms.get(requestId);
    if (!entry) return false;
    this.pendingPerms.delete(requestId);
    entry.resolve(
      decision === 'allow'
        ? { allow: true }
        : { allow: false, deny_reason: 'User denied tool use.' },
    );
    return true;
  }

  resolvePermissionPartial(requestId: string, acceptedHunks: number[]): boolean {
    const entry = this.pendingPerms.get(requestId);
    if (!entry) return false;
    this.pendingPerms.delete(requestId);
    const result = filterToolInputByAcceptedHunks(entry.toolName, entry.input, acceptedHunks);
    if (result.kind === 'reject') {
      entry.resolve({ allow: false, deny_reason: 'User rejected all proposed hunks.' });
      return true;
    }
    if (result.kind === 'updated') {
      entry.resolve({ allow: true, updatedInput: result.updatedInput });
      return true;
    }
    entry.resolve({ allow: true });
    return true;
  }

  async start(opts: StartOptions): Promise<void> {
    if (this.query) return;
    this.permissionMode = opts.permissionMode ?? 'default';
    this.abort = new AbortController();

    // Pre-allocated CLI session UUID forwarded by the renderer (see
    // `src/agent/startSession.ts`). Type-cast through unknown because
    // `StartOptions` lives in `electron/agent/sessions.ts` (the legacy
    // runner's contract) — extending that file is out of scope for PR-D
    // (it's slated for deletion by PR-C). The field is optional and only
    // honoured by the SDK runner; the legacy runner sees it as a stray
    // property and ignores it. SDK rejects combining `sessionId` with
    // `resume`, so we drop it when resuming.
    const presetSessionId = (() => {
      const raw = (opts as unknown as { sessionId?: unknown }).sessionId;
      if (typeof raw !== 'string') return undefined;
      if (opts.resumeSessionId) return undefined;
      // Defence-in-depth UUID shape check. The SDK validates this too and
      // throws on bad input; we'd rather emit a diagnostic than crash the
      // session for a malformed renderer payload.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        this.onDiagnostic({
          level: 'warn',
          code: 'preset_session_id_invalid',
          message: `Ignoring non-UUID sessionId from renderer: ${raw}`,
        });
        return undefined;
      }
      return raw;
    })();

    // Resolve the user's system claude binary up front (PR-A scope: PR-B
    // will swap in the SDK-bundled binary). Throws ClaudeNotFoundError
    // surfaced by manager.ts as `{ ok: false, errorCode: 'CLAUDE_NOT_FOUND' }`.
    let binaryPath: string | undefined = opts.binaryPath;
    if (!binaryPath) {
      try {
        const inv = await resolveClaudeInvocation();
        // The SDK only takes a single executable path; if the resolver
        // returned a `node-script` (npm shim), point at the node script
        // itself — the SDK will spawn it via the configured `executable`.
        // For `cmd-shell` (last-resort .cmd shim), we still pass the .cmd
        // path; modern Node accepts it on Windows when the SDK uses
        // shell-quoted spawn (see SDK's pathToClaudeCodeExecutable docs).
        binaryPath = inv.kind === 'node-script' ? inv.script : inv.path;
      } catch (err) {
        if (err instanceof ClaudeNotFoundError) throw err;
        throw err;
      }
    }

    const sdk = await loadSdk();

    const sdkPermissionMode = toSdkPermissionMode(this.permissionMode);

    this.query = sdk.query({
      prompt: this.makeInputIterable(),
      options: {
        cwd: resolveCwd(opts.cwd),
        env: buildSdkEnv({
          configDir: resolveClaudeConfigDir(opts.configDir),
          envOverrides: opts.envOverrides,
        }),
        model: opts.model,
        permissionMode: sdkPermissionMode,
        allowDangerouslySkipPermissions: sdkPermissionMode === 'bypassPermissions' ? true : undefined,
        resume: opts.resumeSessionId,
        sessionId: presetSessionId,
        pathToClaudeCodeExecutable: binaryPath,
        canUseTool: (toolName, input, ctx) => this.handleCanUseTool(toolName, input, ctx),
        // PreToolUse hook (#94): the CLI's local rule engine handles built-in
        // tools (Bash/Write/Edit/...) entirely client-side and only routes
        // "ask" tools (AskUserQuestion / ExitPlanMode) through canUseTool.
        // Without an external signal, Bash in `default` mode auto-allows
        // based on the CLI's safe-command heuristics — so the renderer's
        // PermissionPromptBlock never renders and probes can't assert the
        // permission flow ran. The legacy wrapper used `--pretool-use-hook`
        // to force every tool through our handler; the SDK exposes the same
        // mechanism via `options.hooks`. Returning `permissionDecision:'ask'`
        // makes the CLI defer to canUseTool. PASSTHROUGH_TOOLS get an
        // explicit `allow` so we don't double-prompt over the renderer's
        // own AskUserQuestion / ExitPlanMode UI (which uses canUseTool too;
        // the canUseTool short-circuit at the top of handleCanUseTool stays
        // as defence-in-depth).
        hooks: {
          PreToolUse: [
            {
              matcher: '.*',
              hooks: [this.makePreToolUseHook()],
            },
          ],
        },
        // Match the legacy spawner: we want partial-message streaming so
        // long replies don't appear frozen.
        includePartialMessages: true,
        abortController: this.abort,
      },
    });

    // Drain the SDK's outbound stream into ccsm's renderer event channel.
    // Errors from the iterator are surfaced via onExit; see the catch below.
    const query = this.query;
    this.consumer = (async () => {
      try {
        for await (const msg of query) {
          if (this.disposed) break;
          // Capture cliSessionId from the first system init frame and
          // diagnose when it differs from ccsm's runner id. With PR-D's
          // pre-allocated sessionId option the two should always match
          // for fresh spawns; a mismatch is informative — either the SDK
          // ignored our sessionId, or this is a resume path where the
          // SDK allocated a fresh sid for the resumed branch.
          const m = msg as SdkMessageLike;
          if (m.type === 'system' && m.subtype === 'init' && !this.cliSessionId) {
            const sid = (m as { session_id?: unknown }).session_id;
            if (typeof sid === 'string') {
              this.cliSessionId = sid;
              if (sid !== this.id) {
                this.onDiagnostic({
                  level: 'warn',
                  code: 'session_id_mismatch',
                  message: `SDK assigned session_id ${sid} but ccsm runner id is ${this.id}. JSONL transcript will not match in-app id.`,
                });
              }
            }
          }
          const translated = translateSdkMessage(m);
          if (translated) this.onEvent(translated);
        }
        this.onExit({ error: undefined });
      } catch (err) {
        // The SDK throws AbortError on intentional close — don't surface that
        // as a user-visible error. Anything else propagates with its message.
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || /aborted/i.test(err.message));
        if (isAbort && this.disposed) {
          this.onExit({ error: undefined });
        } else {
          this.onExit({ error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        this.cleanupAfterExit();
      }
    })();
  }

  /**
   * AsyncIterable that yields user messages as they're pushed via send() /
   * sendContent(). The SDK calls `next()` on this iterable for every
   * outbound user turn; we resolve the next pending Promise when a message
   * arrives, or wait if the queue is empty.
   */
  private async *makeInputIterable(): AsyncIterable<
    import('@anthropic-ai/claude-agent-sdk').SDKUserMessage
  > {
    while (!this.inputClosed) {
      while (this.inputQueue.length > 0) {
        const item = this.inputQueue.shift()!;
        // Intentional `as`: SDK's SDKUserMessage requires `parent_tool_use_id:
        // string | null` and uses MessageParam from @anthropic-ai/sdk for
        // `message`. Our content shape (string | content-block array) matches
        // MessageParam.content and the SDK accepts the looser typing on input.
        yield {
          type: 'user',
          message: { role: 'user', content: item.content as string },
          parent_tool_use_id: null,
        } as unknown as import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
      }
      if (this.inputClosed) break;
      await new Promise<void>((resolve) => {
        this.inputResolve = resolve;
      });
      this.inputResolve = null;
    }
  }

  private wakeInput(): void {
    const r = this.inputResolve;
    if (r) {
      this.inputResolve = null;
      r();
    }
  }

  send(text: string): void {
    if (this.disposed) return;
    this.inputQueue.push({ role: 'user', content: text });
    this.wakeInput();
  }

  sendContent(content: readonly unknown[]): void {
    if (this.disposed) return;
    this.inputQueue.push({ role: 'user', content });
    this.wakeInput();
  }

  /**
   * Bridge SDK canUseTool callback into the host permission UI. The decision
   * shape returned to the SDK is `PermissionResult` (allow/deny union). We
   * translate ccsm's pendingPerms decision into that shape and forward
   * `updatedInput` for partial-accept (#251).
   */
  private async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal; toolUseID: string },
  ): Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult> {
    // Mirror the legacy runner's mode-driven shortcuts: bypass + acceptEdits
    // + auto never prompt. Passthrough tools (AskUserQuestion / ExitPlanMode)
    // are NOT short-circuited here — they MUST flow through onPermissionRequest
    // so the renderer can mount its bespoke question / plan UI. The legacy
    // spawner's `HOOK_PASSTHROUGH_TOOLS` check lived in the PreToolUse-hook
    // path and meant "let the CLI fall through to can_use_tool"; on the SDK
    // runner there's only one path, so a short-circuit here drops the request
    // on the floor — the renderer never sees it, no question card mounts, the
    // SDK gets a synthetic allow, and the agent receives an empty tool_result
    // body. The user observes "agent asked but nothing showed up".
    // NOTE: every `behavior: 'allow'` MUST carry `updatedInput`. The SDK's TS
    // type declares it `.optional()`, but the CLI's over-the-wire Zod schema
    // rejects `updatedInput: undefined` (undefined-serialized-over-wire is
    // distinct from missing-field). Echo `input` unchanged when there's no
    // partial-accept payload. See Bug #169 / PR #313.
    if (
      this.permissionMode === 'bypassPermissions' ||
      this.permissionMode === 'yolo' ||
      this.permissionMode === 'acceptEdits' ||
      this.permissionMode === 'auto'
    ) {
      // For passthrough tools we still need to surface the question UI to
      // the user even in bypass-style modes — bypass means "skip permission
      // prompts for tools the agent calls", not "skip the user-asked-me-a-
      // question UI". Fall through to the onPermissionRequest path.
      if (!PASSTHROUGH_TOOLS.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }
    }

    const decision = await new Promise<CanUseToolDecision>((resolve) => {
      const requestId = `perm-${Date.now().toString(36)}-${(this.nextPermSeq++).toString(36)}`;
      this.pendingPerms.set(requestId, { resolve, toolName, input });
      ctx.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingPerms.delete(requestId)) {
            resolve({ allow: false, deny_reason: 'Permission request cancelled.' });
          }
        },
        { once: true },
      );
      this.onPermissionRequest({ requestId, toolName, input });
    });

    if (decision.allow) {
      // The SDK's TypeScript type marks `updatedInput` optional, but the
      // CLI's over-the-wire schema rejects `updatedInput: undefined` —
      // undefined-serialized-over-wire is distinct from missing-field, and
      // surfaces as `invalid_union / expected: "record", received: undefined`.
      // Reproduced via probe-e2e-permission-allow-* (Bug #169). When the user
      // didn't supply a partial-accept payload, echo the original `input` back
      // unchanged — this matches the on-the-wire shape the CLI expects and
      // is semantically a no-op (allow with no replacement).
      return {
        behavior: 'allow',
        updatedInput: (decision.updatedInput as Record<string, unknown> | undefined) ?? input,
      };
    }
    return {
      behavior: 'deny',
      message: decision.deny_reason ?? 'User denied tool use.',
    };
  }

  /**
   * Build the PreToolUse hook callback (#94). Fires for EVERY tool invocation
   * (matcher `.*`) and forces the CLI to consult our canUseTool callback
   * instead of auto-allowing built-in tools via its safe-command heuristics.
   *
   * Returned shape: `SyncHookJSONOutput` with a `PreToolUseHookSpecificOutput`
   * payload. `permissionDecision: 'ask'` tells the CLI "delegate to the host's
   * canUseTool"; `'allow'` tells it "skip canUseTool and run the tool".
   * Passthrough tools (AskUserQuestion / ExitPlanMode) MUST resolve to 'ask'
   * — returning 'allow' here causes the CLI to bypass canUseTool entirely
   * and synthesize a successful tool_result with empty body, so the renderer
   * never receives the permission-request frame and no question / plan card
   * mounts. The user observes "the agent asked me a question but nothing
   * showed up". Bypass-style modes are still fast-pathed to 'allow' for
   * NON-passthrough tools so we don't pay a host round-trip per tool
   * invocation when the user has explicitly opted out of prompting.
   */
  private makePreToolUseHook(): import('@anthropic-ai/claude-agent-sdk').HookCallback {
    return async (input) => {
      const toolName =
        input.hook_event_name === 'PreToolUse' ? input.tool_name : '';
      const isPassthrough = PASSTHROUGH_TOOLS.has(toolName);
      const isBypassMode =
        this.permissionMode === 'bypassPermissions' ||
        this.permissionMode === 'yolo' ||
        this.permissionMode === 'acceptEdits' ||
        this.permissionMode === 'auto';
      // Passthrough tools always 'ask' — see jsdoc above. Bypass-mode
      // short-circuit only applies to non-passthrough tools.
      const decision: import('@anthropic-ai/claude-agent-sdk').HookPermissionDecision =
        !isPassthrough && isBypassMode ? 'allow' : 'ask';
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
        },
      };
    };
  }

  async interrupt(): Promise<void> {
    if (!this.query) return;
    try {
      await this.query.interrupt();
    } catch (err) {
      // Match the legacy behaviour: surface a soft warning so a Stop click
      // that didn't land gets explained. Hard kill happens via this.abort.
      this.onDiagnostic({
        level: 'warn',
        code: 'interrupt_timeout',
        message: `Agent didn't acknowledge interrupt (${
          err instanceof Error ? err.message : String(err)
        }). Force-killing.`,
      });
    }
  }

  async cancelToolUse(toolUseId: string): Promise<void> {
    if (!this.query) return;
    // Same fallback as the legacy runner: SDK has no per-tool cancel today,
    // so a per-tool Cancel falls back to a turn-level interrupt. Per-tool
    // Cancel is a normal user action, so we log to stdout (for ccsm-side
    // debugging) instead of emitting a user-facing diagnostic banner.
    console.warn(
      `[ccsm] tool cancel falling back to turn-level interrupt: SDK lacks scoped cancel API (toolUseId=${toolUseId})`,
    );
    await this.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const sdkMode = toSdkPermissionMode(mode);
    this.permissionMode = mode;
    if (!this.query || !sdkMode) return;
    try {
      await this.query.setPermissionMode(sdkMode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Distinguish hard SDK rejection (unsupported mode for this
      // account/model — typically `auto` research-preview gating) from a
      // transient timeout. Hard rejections are re-thrown so manager.ts /
      // main.ts can surface `{ ok: false, error }` to the renderer, which
      // falls back to 'default' with a toast. Timeouts stay as
      // diagnostics — the user already sees session-level "unresponsive"
      // affordances and we don't want to flap the picker on a slow turn.
      if (/unsupported|not supported|requires|capability|gated|forbidden|denied/i.test(msg)) {
        throw err;
      }
      this.onDiagnostic({
        level: 'warn',
        code: 'set_permission_mode_timeout',
        message: `Agent unresponsive to permission-mode change (${msg}).`,
      });
    }
  }

  /**
   * Push an updated `max_thinking_tokens` cap into the live SDK session.
   * Sent unconditionally (including the value 0) so toggling `/think` off
   * produces an explicit clear, matching upstream's behaviour. No-op until
   * `start()` has installed `this.query`.
   */
  async setMaxThinkingTokens(tokens: number): Promise<void> {
    if (!this.query) return;
    try {
      // SDK exposes setMaxThinkingTokens on the Query handle (mirrors
      // upstream `extension.setThinkingLevel` → `query.setMaxThinkingTokens`).
      const q = this.query as unknown as {
        setMaxThinkingTokens?: (n: number) => Promise<void>;
      };
      if (typeof q.setMaxThinkingTokens !== 'function') {
        this.onDiagnostic({
          level: 'warn',
          code: 'set_max_thinking_tokens_unsupported',
          message: 'SDK Query.setMaxThinkingTokens missing — extended thinking toggle ignored.',
        });
        return;
      }
      await q.setMaxThinkingTokens(tokens);
    } catch (err) {
      this.onDiagnostic({
        level: 'warn',
        code: 'set_max_thinking_tokens_timeout',
        message: `Agent unresponsive to thinking-tokens change (${
          err instanceof Error ? err.message : String(err)
        }).`,
      });
    }
  }

  async setModel(model?: string): Promise<void> {
    if (!this.query || !model) return;
    try {
      await this.query.setModel(model);
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
    for (const entry of this.pendingPerms.values()) {
      entry.resolve({ allow: false, deny_reason: 'Session closed.' });
    }
    this.pendingPerms.clear();
    this.inputClosed = true;
    this.wakeInput();
    // Trigger the SDK's abort path. The SDK's Query.close() also exists but
    // the abort signal is a single source of truth that the SDK already
    // wires through to the subprocess.
    try {
      this.abort?.abort();
    } catch {
      /* ignore */
    }
    try {
      this.query?.close();
    } catch {
      /* ignore — close() may throw if abort already tore the query down */
    }
  }

  private cleanupAfterExit(): void {
    this.disposed = true;
    this.inputClosed = true;
    this.wakeInput();
    for (const entry of this.pendingPerms.values()) {
      entry.resolve({ allow: false, deny_reason: 'Session ended.' });
    }
    this.pendingPerms.clear();
    this.query = null;
    this.abort = null;
  }
}

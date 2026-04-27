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
import {
  projectEffortToWire,
  thinkingTokensForLevel,
  nextLowerEffort,
  isEffortRejectionError,
} from '../../src/agent/effort';

type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  // Disable the CLI's IDE-companion auto-discovery. Without this, the
  // bundled CLI scans `${CLAUDE_CONFIG_DIR}/ide/*.lock` (dropped there by
  // the VS Code / JetBrains / Cursor Claude Code extension) and, when a
  // lockfile's workspaceFolders match the session cwd, attaches itself as
  // an IDE-integrated session — at which point the agent's system context
  // identifies the run as "Claude Code (VS Code integration)" and the user
  // gets editor-tab + diagnostics tools they have no UI for. ccsm is an
  // independent Electron app, never a VS Code extension; we always want
  // the standalone identity. Bundled-CLI gate is
  // `(autoConnectIde || ... || CLAUDE_CODE_AUTO_CONNECT_IDE) && !a7(CLAUDE_CODE_AUTO_CONNECT_IDE)`
  // — setting the env to a false-string makes `a7()` true, killing the
  // whole condition regardless of the user's settings.json
  // `autoConnectIde` value or any other heuristic. See PR fixing
  // "agent self-reports as VS Code integration".
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
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
  private effortLevel: EffortLevel = 'high';

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

    // Project the resolved chip level into the SDK's two dimensions. Sent
    // EXPLICITLY at launch (even for the default 'high') so the chip's
    // value is the single source of truth — the bundled CLI's
    // settings.json default doesn't get to second-guess us. Mirrors the
    // VS Code extension's wire path.
    //
    // Optimistic gating: ccsm UI never disables effort tiers. If the CLI
    // rejects the user-selected tier as unsupported for the current model
    // (typical alias surface: `opus[1m]` -> Opus 4.7 1M which has different
    // tier ceilings than the alias regex would suggest), we auto-downgrade
    // one tier at a time (max -> xhigh -> ... -> off) and retry. The
    // chip's visible label in StatusBar stays at the user-selected tier;
    // each downgrade emits a diagnostic.
    const userEffort: EffortLevel = opts.effortLevel ?? 'high';
    this.effortLevel = userEffort;

    // Spawn the first attempt synchronously so `start()` returns immediately
    // (matching the legacy contract: manager.ts races its first-event signal
    // against an 800ms timeout AFTER start() resolves). The retry loop lives
    // entirely inside the spawned consumer chain — see `attemptRun` below.
    this.consumer = this.attemptRun(sdk, {
      sdkPermissionMode,
      presetSessionId,
      binaryPath,
      cwd: opts.cwd,
      configDir: resolveClaudeConfigDir(opts.configDir),
      envOverrides: opts.envOverrides,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      userEffort,
      currentEffort: userEffort,
    });
  }

  private async attemptRun(
    sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    ctx: {
      sdkPermissionMode: ReturnType<typeof toSdkPermissionMode>;
      presetSessionId: string | undefined;
      binaryPath: string | undefined;
      cwd: string;
      configDir: string;
      envOverrides: Record<string, string> | undefined;
      model: string | undefined;
      resumeSessionId: string | undefined;
      userEffort: EffortLevel;
      currentEffort: EffortLevel;
    },
  ): Promise<void> {
    let attemptedDowngrade = false;
    // Attempt loop: tries up to 6 tiers (max -> off). Each iteration sets
    // up the consumer; on effort-rejection at the initial handshake we
    // tear down and retry. Any non-effort error or stream-mid error is
    // surfaced normally via onExit.
    while (true) {
      if (this.disposed) return;
      // Refresh abort controller each retry — the previous one is wired to
      // the torn-down query.
      if (!this.abort) this.abort = new AbortController();
      const wire = projectEffortToWire(ctx.currentEffort);

      const query = sdk.query({
        prompt: this.makeInputIterable(),
        options: {
          cwd: resolveCwd(ctx.cwd),
          env: buildSdkEnv({
            configDir: ctx.configDir,
            envOverrides: ctx.envOverrides,
          }),
          model: ctx.model,
          permissionMode: ctx.sdkPermissionMode,
          // Always pass allowDangerouslySkipPermissions: true so users can
          // switch to bypassPermissions mid-session via the chip without
          // restarting. The SDK gate is one-way: the launch flag is only
          // required to ENTER bypassPermissions; switching out of bypass
          // needs no flag. Without this, sessions launched in `default`
          // mode hit "was not launched with --dangerously-skip-permissions"
          // when the user clicks the bypass chip, surfacing as a vague
          // "Agent unresponsive" toast.
          allowDangerouslySkipPermissions: true,
          resume: ctx.resumeSessionId,
          sessionId: ctx.presetSessionId,
          pathToClaudeCodeExecutable: ctx.binaryPath,
          // 6-tier effort+thinking chip → SDK options. `thinking: 'disabled'`
          // when the chip is Off, `'adaptive'` (Claude decides budget) for
          // every other tier. `effort` carries the actual tier label and is
          // omitted when Off (the SDK's model-default is then irrelevant
          // because thinking is disabled). See src/agent/effort.ts for the
          // mapping table.
          thinking: wire.thinking,
          effort: wire.effort,
          canUseTool: (toolName, input, c) => this.handleCanUseTool(toolName, input, c),
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
      this.query = query;

      // Probe the initialize handshake before committing to the consumer
      // loop. Effort rejections from the CLI surface here (control_response
      // with subtype:"error") as a rejection from .next(); we tear down and
      // retry one tier lower. Any other error or success falls through to
      // the production consumer path.
      const probe = await this.probeFirstMessage(query);

      if (probe.kind === 'effort-rejected') {
        const downgrade = nextLowerEffort(ctx.currentEffort);
        try { query.close(); } catch { /* ignore */ }
        this.query = null;
        this.abort = null;
        if (downgrade === null) {
          // Already at 'off'; surface the original error via onExit.
          this.onExit({ error: probe.error });
          this.cleanupAfterExit();
          return;
        }
        this.onDiagnostic({
          level: 'warn',
          code: 'effort_downgrade_on_launch',
          message: `Model rejected effort=${ctx.currentEffort} at launch (${probe.error}); retrying with ${downgrade}.`,
        });
        attemptedDowngrade = true;
        ctx.currentEffort = downgrade;
        // Note: we keep `this.effortLevel = userEffort` unchanged — the chip
        // continues to render the user-selected tier even though the runner
        // is now at the downgraded one.
        continue;
      }

      if (probe.kind === 'other-error') {
        this.query = null;
        this.abort = null;
        this.onExit({ error: probe.error });
        this.cleanupAfterExit();
        return;
      }

      // Success path.
      if (attemptedDowngrade) {
        this.onDiagnostic({
          level: 'warn',
          code: 'effort_downgraded_active',
          message: `Effort level downgraded to ${ctx.currentEffort} (user selected ${ctx.userEffort}); chip label unchanged.`,
        });
      }
      await this.runConsumer(probe.iterator, probe.first);
      return;
    }
  }

  /**
   * Pull the first SDK message off a freshly-created query handle so we can
   * detect a CLI-side rejection of the launch options (notably an unsupported
   * `effort` tier) before committing to the production consumer loop. Returns
   * either the buffered first message (`success`) or a classified error.
   *
   * The real SDK Query exposes `next()` directly on the handle; tests
   * sometimes only expose the iterator protocol. We grab `Symbol.asyncIterator`
   * once and reuse it for both the probe and the production consumer (passed
   * through via `runConsumer`'s `iterator` arg) so the consumer sees no gap
   * between the buffered first message and subsequent frames.
   */
  private async probeFirstMessage(
    query: import('@anthropic-ai/claude-agent-sdk').Query,
  ): Promise<
    | {
        kind: 'success';
        first: SdkMessageLike | undefined;
        iterator: AsyncIterator<unknown>;
      }
    | { kind: 'effort-rejected'; error: string }
    | { kind: 'other-error'; error: string }
  > {
    const iterable = query as unknown as AsyncIterable<unknown>;
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      const result = await iterator.next();
      if (result.done) {
        return { kind: 'success', first: undefined, iterator };
      }
      return {
        kind: 'success',
        first: result.value as SdkMessageLike,
        iterator,
      };
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted/i.test(err.message));
      if (isAbort && this.disposed) {
        return { kind: 'other-error', error: '' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (isEffortRejectionError(err)) {
        return { kind: 'effort-rejected', error: msg };
      }
      return { kind: 'other-error', error: msg };
    }
  }

  /**
   * Drain the SDK's outbound stream into ccsm's renderer event channel.
   * Errors from the iterator are surfaced via onExit. Takes the iterator
   * already drawn by `probeFirstMessage` plus its buffered first message
   * so no frame is dropped between probe and consumer handoff.
   */
  private async runConsumer(
    iterator: AsyncIterator<unknown>,
    bufferedFirst: SdkMessageLike | undefined,
  ): Promise<void> {
    try {
      if (bufferedFirst !== undefined) {
        this.handleSdkMessage(bufferedFirst);
      }
      while (!this.disposed) {
        const r = await iterator.next();
        if (r.done) break;
        this.handleSdkMessage(r.value as SdkMessageLike);
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
  }

  private handleSdkMessage(m: SdkMessageLike): void {
    // Capture cliSessionId from the first system init frame and
    // diagnose when it differs from ccsm's runner id. With PR-D's
    // pre-allocated sessionId option the two should always match
    // for fresh spawns; a mismatch is informative — either the SDK
    // ignored our sessionId, or this is a resume path where the
    // SDK allocated a fresh sid for the resumed branch.
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
      // account/model — typically `auto` research-preview gating, or
      // `bypassPermissions` when the launch flag was withheld) from a
      // transient timeout. Hard rejections are re-thrown so manager.ts /
      // main.ts can surface `{ ok: false, error }` to the renderer, which
      // falls back to 'default' with a toast. Timeouts stay as
      // diagnostics — the user already sees session-level "unresponsive"
      // affordances and we don't want to flap the picker on a slow turn.
      if (/unsupported|not supported|requires|capability|gated|forbidden|denied|was not launched|dangerously-skip-permissions/i.test(msg)) {
        throw err;
      }
      this.onDiagnostic({
        level: 'warn',
        code: 'set_permission_mode_timeout',
        message: `Permission mode change timed out (${msg}).`,
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

  /**
   * Push a 6-tier effort chip change into the live SDK session.
   *
   * Mid-session change requires TWO concurrent control RPCs because the
   * SDK splits the chip's two underlying dimensions:
   *   1) `setMaxThinkingTokens` carries the thinking on/off bit
   *      (null = enable adaptive thinking; 0 = disable).
   *   2) `applyFlagSettings({ effortLevel })` carries the tier itself
   *      (low/medium/high/xhigh; SDK's `Settings.effortLevel` schema does
   *      NOT include 'max' — for 'max' we still send applyFlagSettings as
   *      a best-effort, casting through unknown; the SDK's CLI validates
   *      and the catch below downgrades to a soft diagnostic if rejected).
   *
   * Both go out at the same time (`Promise.all`) so a slow turn doesn't
   * see a half-applied state where thinking flipped but effort didn't.
   * No session restart.
   *
   * For the 'off' chip: only RPC #1 is meaningful (thinking off; tier is
   * irrelevant). We still send #2 as 'low' so a flip back ON re-syncs
   * cleanly without leaving stale higher-tier state on the SDK side.
   *
   * Optimistic gating: ccsm UI never disables effort tiers. If the CLI
   * rejects `applyFlagSettings({ effortLevel })` as unsupported for the
   * current model, we auto-downgrade one tier at a time (max -> xhigh ->
   * ... -> off) and retry until accepted. The chip's visible label keeps
   * showing the user-selected tier; the runner's `this.effortLevel` is
   * what the chip reads, so it must stay at `level` even when the wire
   * value drops below it.
   */
  async setEffort(level: EffortLevel): Promise<void> {
    this.effortLevel = level;
    if (!this.query) return;
    const tokens = thinkingTokensForLevel(level);

    const q = this.query as unknown as {
      setMaxThinkingTokens?: (n: number | null) => Promise<void>;
      applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
    };

    const tasks: Promise<unknown>[] = [];
    if (typeof q.setMaxThinkingTokens === 'function') {
      tasks.push(
        q.setMaxThinkingTokens(tokens).catch((err) => {
          this.onDiagnostic({
            level: 'warn',
            code: 'set_max_thinking_tokens_timeout',
            message: `Agent unresponsive to thinking change (${
              err instanceof Error ? err.message : String(err)
            }).`,
          });
        }),
      );
    } else {
      this.onDiagnostic({
        level: 'warn',
        code: 'set_max_thinking_tokens_unsupported',
        message: 'SDK Query.setMaxThinkingTokens missing — chip flip ignored.',
      });
    }
    if (typeof q.applyFlagSettings === 'function') {
      tasks.push(this.applyEffortWithFallback(q.applyFlagSettings.bind(q), level));
    } else {
      this.onDiagnostic({
        level: 'warn',
        code: 'apply_flag_settings_unsupported',
        message: 'SDK Query.applyFlagSettings missing — effort tier change ignored.',
      });
    }
    await Promise.all(tasks);
  }

  /**
   * Send `applyFlagSettings({ effortLevel })` with auto-downgrade on CLI
   * rejection. See `setEffort` jsdoc for the gating rationale. Stops at
   * the first wire value that succeeds; gives up at 'off' (which would
   * have nothing to send and is treated as success). Each downgrade
   * emits an `effort_downgrade_on_apply` diagnostic.
   */
  private async applyEffortWithFallback(
    applyFlagSettings: (settings: Record<string, unknown>) => Promise<void>,
    requested: EffortLevel,
  ): Promise<void> {
    let current: EffortLevel = requested;
    while (true) {
      // 'off' is meaningless on the wire (thinking already disabled via
      // setMaxThinkingTokens); we send `low` as a stable resync-anchor
      // matching the pre-fallback behaviour. Treat as terminal success.
      const wire: 'low' | 'medium' | 'high' | 'xhigh' | 'max' =
        current === 'off' ? 'low' : current;
      try {
        await applyFlagSettings({ effortLevel: wire });
        return;
      } catch (err) {
        if (!isEffortRejectionError(err)) {
          this.onDiagnostic({
            level: 'warn',
            code: 'apply_flag_settings_failed',
            message: `Agent unresponsive to effort change (${
              err instanceof Error ? err.message : String(err)
            }).`,
          });
          return;
        }
        const downgrade = nextLowerEffort(current);
        if (downgrade === null) {
          this.onDiagnostic({
            level: 'warn',
            code: 'apply_flag_settings_failed',
            message: `Effort change rejected at every tier; giving up (${
              err instanceof Error ? err.message : String(err)
            }).`,
          });
          return;
        }
        this.onDiagnostic({
          level: 'warn',
          code: 'effort_downgrade_on_apply',
          message: `Model rejected effort=${current} mid-session (${
            err instanceof Error ? err.message : String(err)
          }); retrying with ${downgrade}.`,
        });
        current = downgrade;
      }
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

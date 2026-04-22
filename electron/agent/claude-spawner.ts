import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  classifyInvocation,
  quoteCmdArg,
  resolveClaudeBinary,
  type ResolvedInvocation,
} from './binary-resolver';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

export interface SpawnOpts {
  /** Working directory for the Claude process. Used as the project root. */
  cwd: string;
  /** Resume an existing CLI session (passes `--resume <id>`). */
  resumeId?: string;
  /** `--permission-mode` flag value. Defaults to leaving the flag off. */
  permissionMode?: PermissionMode;
  /** `--model <id>`. */
  model?: string;
  /**
   * Extra environment variables to merge (after the safe-env baseline).
   * Use this for `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
   * `CLAUDE_CODE_SKIP_AUTH_LOGIN` etc.
   */
  envOverrides?: Record<string, string>;
  /**
   * `CLAUDE_CONFIG_DIR` value. **Required** — the spawner refuses to fall
   * back to the user's `~/.claude`. The caller (Electron main) must compute
   * this from `app.getPath('userData')` so we never know that path here.
   */
  configDir: string;
  /** Pre-resolved binary path. If absent, calls `resolveClaudeBinary()`. */
  binaryPath?: string;
  /**
   * Cancel the spawn / kill the child. SIGTERM is sent first; if the
   * process is still alive after `killGracePeriodMs`, SIGKILL follows.
   *
   * NOTE: if you pass an *already-aborted* signal, the child will be sent
   * SIGTERM in a microtask immediately after `spawnClaude` resolves. The
   * caller MUST attach stdout/stderr listeners synchronously after the
   * await — any further `await` before doing so risks missing pre-kill
   * output (and on Windows, where SIGTERM == TerminateProcess, *all*
   * unflushed output).
   */
  signal?: AbortSignal;
  /**
   * Override the SIGTERM → SIGKILL grace period (default 5000ms).
   *
   * Windows footnote: on Windows, `child.kill('SIGTERM')` is implemented
   * by Node as `TerminateProcess`, which is an immediate hard-kill — there
   * is no graceful-shutdown signal to deliver. The grace timer is kept for
   * symmetry with POSIX, but in practice the child is gone before SIGKILL
   * fires. For a Windows-friendly graceful stop, the *caller* should:
   *   1. Send the appropriate stream-json `interrupt` control message.
   *   2. `cp.stdin.end()` to close claude's stdin (lets it exit cleanly).
   *   3. Wait briefly (claude flushes + exits on its own).
   *   4. THEN call `cp.kill('SIGTERM')` as the hard fallback.
   * This is a sessions/control-rpc layer concern; the spawner only exposes
   * the primitives.
   */
  killGracePeriodMs?: number;
}

export interface ClaudeProcess {
  readonly pid: number | undefined;
  /**
   * Raw bytes from the child's stdout. The CLI emits NDJSON (one JSON
   * object per line), but a single line can be split across `data` chunks
   * (especially >64KB messages on Windows pipes). Callers MUST run this
   * through a line-buffering splitter (e.g. NDJSONSplitter / split2) and
   * MUST NOT call `JSON.parse(chunk.toString())`. NDJSON framing is
   * intentionally NOT a spawn-layer concern — it belongs to control-rpc.
   */
  readonly stdout: Readable;
  /**
   * Raw stderr bytes. The spawner also internally tails stderr into a
   * small in-memory ring; see `getRecentStderr()`.
   */
  readonly stderr: Readable;
  readonly stdin: Writable;
  /** Resolves with the child exit code/signal. Never rejects. */
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Send a signal (defaults to SIGTERM). Idempotent after exit. */
  kill(signal?: NodeJS.Signals): void;
  /**
   * Most recent ~8KB of stderr the child emitted. Useful when the child
   * exits non-zero with no other context (auth errors, OAuth redirect
   * failures, missing CA, etc.). Empty string if the child wrote nothing.
   */
  getRecentStderr(): string;
}

const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Cap for the in-memory stderr ring buffer. 8KB matches the M1 spec §7.1
 * recommendation — large enough to capture multi-line auth errors and Node
 * stack traces, small enough that we don't accidentally hold gigabytes if
 * the child spews indefinitely.
 */
const STDERR_RING_BYTES = 8 * 1024;

/**
 * Env vars we always preserve from the parent process. Two-tier whitelist:
 *   - `exact`: case-sensitive whole-name match (Windows env is itself
 *     case-insensitive, but we use OS-canonical casing where it matters
 *     for downstream programs that look up by exact key).
 *   - `prefixes`: case-sensitive prefix match. Used for families of vars
 *     where enumerating is impractical (`LC_*`, `NPM_CONFIG_*`, `NVM_*`,
 *     etc.).
 *
 * Anything not matched is dropped (deny-by-default). `NODE_OPTIONS` and
 * `ELECTRON_RUN_AS_NODE` are *also* explicitly deleted post-merge to
 * defend against caller `envOverrides` accidentally re-introducing them.
 */
export const SAFE_ENV: { exact: readonly string[]; prefixes: readonly string[] } = {
  exact: [
    // POSIX core
    'PATH', 'HOME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'USER', 'LOGNAME', 'TZ',
    // Windows core (canonical casing)
    'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PATHEXT', 'ComSpec', 'OS',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'COMPUTERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE',
    'HOMEDRIVE', 'HOMEPATH',
    // Tools / version managers (NVM_DIR / FNM_DIR fall under prefixes too)
    'NVM_DIR', 'FNM_DIR', 'NODE_VERSION',
    // Network / proxy
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
    // SSL / CA bundles
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    // SSH agent (so git push from Bash tool works)
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    // XDG (POSIX config dirs)
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    // TTY / color hints
    'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'CI',
  ],
  prefixes: [
    'LC_',           // LC_ALL, LC_CTYPE, LC_MESSAGES, LC_TIME, ...
    'NPM_CONFIG_',   // npm config (uppercase form)
    'npm_config_',   // npm internal (lowercase, propagated by npm itself)
    'NVM_',          // nvm (NVM_DIR, NVM_BIN, ...)
    'FNM_',          // fnm (FNM_DIR, FNM_MULTISHELL_PATH, ...)
    'VOLTA_',        // volta toolchain
    'ProgramFiles',  // ProgramFiles, ProgramFiles(x86), ProgramFilesPath
    'CommonProgram', // CommonProgramFiles, CommonProgramFiles(x86)
    'ProgramData',   // ProgramData, ProgramData(x86) (rare but cheap)
    // Anthropic / claude.exe credentials + endpoint configuration. This is
    // the core self-host differentiator: user points ANTHROPIC_BASE_URL at
    // their own gateway, sets ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY, and
    // claude.exe authenticates without needing a stored ~/.claude login.
    // Covers: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL, ANTHROPIC_SMALL_FAST_MODEL,
    // ANTHROPIC_CUSTOM_HEADERS, and any future ANTHROPIC_* the CLI adds.
    'ANTHROPIC_',
    // claude.exe runtime flags (Bedrock/Vertex routing, proxy, etc.).
    // Covers: CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX,
    // CLAUDE_CODE_SKIP_AUTH_LOGIN, CLAUDE_CODE_DISABLE_*, etc. We still
    // force CLAUDE_CONFIG_DIR / CLAUDE_CODE_ENTRYPOINT below to our own
    // values — prefix inclusion just means we pass them through first,
    // then overwrite the two we own.
    'CLAUDE_CODE_',
  ],
};

// Back-compat: tests / external readers that referenced the old flat list.
// Computed eagerly so it stays a `readonly string[]`.
const SAFE_ENV_KEYS: readonly string[] = SAFE_ENV.exact;

function envKeyAllowed(key: string): boolean {
  if (process.platform === 'win32') {
    // Windows env is fundamentally case-insensitive (and Node uppercases
    // many keys during `Object.entries(process.env)` iteration). Match
    // both whitelists case-insensitively here to avoid losing things like
    // `COMSPEC` (canonical: `ComSpec`) or `PROGRAMFILES` (canonical:
    // `ProgramFiles`).
    const lk = key.toLowerCase();
    for (const e of SAFE_ENV.exact) {
      if (e.toLowerCase() === lk) return true;
    }
    for (const p of SAFE_ENV.prefixes) {
      if (lk.startsWith(p.toLowerCase())) return true;
    }
    return false;
  }
  if (SAFE_ENV.exact.includes(key)) return true;
  for (const p of SAFE_ENV.prefixes) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

/**
 * Build the env passed to claude.exe. Strategy: start from a deny-by-default
 * baseline (only SAFE_ENV-matched keys), then layer required values + caller
 * overrides. Anything else from the Electron process (NODE_OPTIONS,
 * ELECTRON_RUN_AS_NODE, etc.) is dropped on the floor.
 */
export function buildSpawnEnv(opts: {
  configDir: string;
  envOverrides?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (envKeyAllowed(k)) env[k] = v;
  }

  // Required: isolate config so we never pollute the user's ~/.claude.
  env.CLAUDE_CONFIG_DIR = opts.configDir;

  // Identifies us in server-side logs. We unconditionally overwrite the
  // parent's CLAUDE_CODE_ENTRYPOINT (which will be `cli` when Agentory is
  // spawned from a Claude Code session for dogfooding) so every spawn from
  // Agentory reports as `agentory-desktop`. envOverrides below can still
  // rename it (e.g. for tests).
  env.CLAUDE_CODE_ENTRYPOINT = 'agentory-desktop';

  // Caller overrides win — this is where ANTHROPIC_BASE_URL /
  // ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_SKIP_AUTH_LOGIN come in.
  if (opts.envOverrides) {
    for (const [k, v] of Object.entries(opts.envOverrides)) {
      env[k] = v;
    }
  }

  // Defensive: even if a caller smuggled these in via overrides, strip the
  // two known Electron poisons before exec. Always wins over the override.
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;

  return env;
}

/**
 * Build the argv passed to claude. Order matches the M1 guide:
 *   stream-json IO + verbose first, optional flags after.
 */
export function buildSpawnArgs(opts: {
  resumeId?: string;
  permissionMode?: PermissionMode;
  model?: string;
}): string[] {
  const args: string[] = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    // Delegate per-tool permission decisions to the host over the same stdio
    // channel. Without this flag, claude.exe never emits `can_use_tool`
    // control_requests for tools that would otherwise prompt (Write/Edit/etc.) —
    // it falls back to the local rule engine and silently auto-allows or auto-
    // denies based on settings + permissionMode. The literal value `"stdio"`
    // (rather than an MCP tool name) is the magic token the CLI recognises as
    // "the SDK consumer on the other side handles permissions"; this is what
    // `@anthropic-ai/claude-agent-sdk` injects when a `canUseTool` callback is
    // provided. The companion handshake (an `initialize` control_request) is
    // sent by SessionRunner once the child is up.
    '--permission-prompt-tool',
    'stdio',
  ];
  if (opts.permissionMode) {
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.resumeId) {
    args.push('--resume', opts.resumeId);
  }
  return args;
}

class ClaudeProcessImpl implements ClaudeProcess {
  private exited = false;
  private exitInfo: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private waitPromise: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private killTimer: NodeJS.Timeout | null = null;
  private stderrRing: Buffer[] = [];
  private stderrRingBytes = 0;

  constructor(
    private readonly child: ChildProcess,
    private readonly killGraceMs: number,
    signal: AbortSignal | undefined
  ) {
    // Tail stderr into a small ring buffer so callers that don't attach a
    // listener can still see *why* the child died. We also leave the stderr
    // stream unconsumed for callers that *do* want it — Node permits
    // multiple readers on a Readable as long as we only `.on('data')`,
    // never `.pipe()` (piping would consume the data exclusively).
    if (this.child.stderr) {
      this.child.stderr.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        this.stderrRing.push(buf);
        this.stderrRingBytes += buf.length;
        // Trim from the front until we're under cap.
        while (this.stderrRingBytes > STDERR_RING_BYTES && this.stderrRing.length > 0) {
          const head = this.stderrRing[0];
          if (this.stderrRingBytes - head.length >= STDERR_RING_BYTES) {
            this.stderrRing.shift();
            this.stderrRingBytes -= head.length;
          } else {
            // Partial trim of head: slice off enough bytes to fit cap.
            const overflow = this.stderrRingBytes - STDERR_RING_BYTES;
            this.stderrRing[0] = head.subarray(overflow);
            this.stderrRingBytes -= overflow;
            break;
          }
        }
      });
      // Don't let stderr reading errors crash us if the child dies mid-write.
      this.child.stderr.on('error', () => {
        /* ignore: child went away */
      });
    }

    this.waitPromise = new Promise((resolve) => {
      const onExit = (
        code: number | null,
        sig: NodeJS.Signals | null
      ): void => {
        if (this.exited) return;
        this.exited = true;
        this.exitInfo = { code, signal: sig };
        if (this.killTimer) {
          clearTimeout(this.killTimer);
          this.killTimer = null;
        }
        resolve(this.exitInfo);
      };
      child.on('exit', onExit);
      // 'error' (e.g. ENOENT) without an exit — synthesise a -1.
      child.on('error', () => {
        if (!this.exited) onExit(-1, null);
      });
    });

    if (signal) {
      const onAbort = (): void => {
        this.kill('SIGTERM');
      };
      if (signal.aborted) {
        // Schedule on a microtask so `spawnClaude()`'s caller gets the
        // ClaudeProcess reference *before* the abort handler runs. Caller
        // MUST consume the returned cp synchronously (i.e. don't `await`
        // anything else before attaching listeners) — see SpawnOpts.signal
        // doc. Otherwise pre-kill stdout/stderr can be lost.
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  get stdout(): Readable {
    if (!this.child.stdout) throw new Error('claude child has no stdout pipe');
    return this.child.stdout;
  }
  get stderr(): Readable {
    if (!this.child.stderr) throw new Error('claude child has no stderr pipe');
    return this.child.stderr;
  }
  get stdin(): Writable {
    if (!this.child.stdin) throw new Error('claude child has no stdin pipe');
    return this.child.stdin;
  }

  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.waitPromise;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exited) return;
    try {
      this.child.kill(signal);
    } catch {
      /* already dead */
    }
    if (signal === 'SIGTERM' && !this.killTimer) {
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        if (this.exited) return;
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, this.killGraceMs);
      // Don't let this timer keep the event loop alive on its own.
      this.killTimer.unref?.();
    }
  }

  getRecentStderr(): string {
    if (this.stderrRing.length === 0) return '';
    return Buffer.concat(this.stderrRing, this.stderrRingBytes).toString('utf8');
  }
}

/**
 * Spawn a claude.exe child wired up for stream-json IO. Throws synchronously
 * on bad inputs (missing configDir, missing binary). Process-level failures
 * (ENOENT after spawn) surface via `wait()` resolving with code -1.
 *
 * Windows shim handling: on Windows, `where claude` returns a `.cmd` shim.
 * Spawning `.cmd` with `shell: false` was hardened in Node 18.20.2+ /
 * 20.12.2+ / 21.7.3+ (CVE-2024-27980) and now throws. We avoid this by
 * either (a) parsing the shim to find the underlying `.exe` / node script
 * and spawning that directly, or (b) falling back to `shell: true` + manual
 * argv quoting if the shim shape is unrecognized. See `binary-resolver`.
 */
export async function spawnClaude(opts: SpawnOpts): Promise<ClaudeProcess> {
  if (!opts.configDir || opts.configDir.trim().length === 0) {
    throw new Error(
      'spawnClaude: configDir is required (caller must pass an isolated CLAUDE_CONFIG_DIR path, e.g. <userData>/claude-cli-config)'
    );
  }

  const invocation: ResolvedInvocation = opts.binaryPath
    ? classifyInvocation(opts.binaryPath)
    : await (async () => {
        // Inline import to keep the resolver's network of helpers off the
        // hot path for callers that pre-resolve `binaryPath`.
        const { resolveClaudeInvocation } = await import('./binary-resolver');
        return resolveClaudeInvocation();
      })();

  const userArgs = buildSpawnArgs({
    resumeId: opts.resumeId,
    permissionMode: opts.permissionMode,
    model: opts.model,
  });
  const env = buildSpawnEnv({
    configDir: opts.configDir,
    envOverrides: opts.envOverrides,
  });

  let command: string;
  let argv: string[];
  let useShell = false;

  switch (invocation.kind) {
    case 'direct':
      command = invocation.path;
      argv = userArgs;
      break;
    case 'node-script':
      command = invocation.node;
      argv = [invocation.script, ...userArgs];
      break;
    case 'cmd-shell':
      // Hand the full quoted command line to cmd.exe ourselves. With
      // `shell: true`, Node will splice argv with spaces — we pre-quote
      // every token (path included) so cmd.exe parses the result safely.
      command = [quoteCmdArg(invocation.path), ...userArgs.map(quoteCmdArg)].join(' ');
      argv = [];
      useShell = true;
      break;
  }

  const child = spawn(command, argv, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // `shell: false` is the default and only safe option once we've
    // unwrapped the shim. We flip to `true` only for the cmd-shell
    // fallback, where every arg is already cmd-quoted.
    shell: useShell,
  });

  return new ClaudeProcessImpl(
    child,
    opts.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS,
    opts.signal
  );
}

// Re-export for tests / callers that want pure-function access.
export const __test__ = {
  buildSpawnArgs,
  buildSpawnEnv,
  SAFE_ENV_KEYS,
  SAFE_ENV,
  envKeyAllowed,
  STDERR_RING_BYTES,
};

// Keep an explicit named export of the resolver so callers can pre-resolve
// once and pass `binaryPath` to many spawnClaude() calls.
export { resolveClaudeBinary };

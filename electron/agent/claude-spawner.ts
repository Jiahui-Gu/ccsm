import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolveClaudeBinary } from './binary-resolver';

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
   */
  signal?: AbortSignal;
  /** Override the SIGTERM → SIGKILL grace period (default 5000ms). */
  killGracePeriodMs?: number;
}

export interface ClaudeProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  /** Resolves with the child exit code/signal. Never rejects. */
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Send a signal (defaults to SIGTERM). Idempotent after exit. */
  kill(signal?: NodeJS.Signals): void;
}

const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Env vars we always preserve from the parent process so the child can run
 * at all (PATH, system locations, proxy settings, etc.).
 */
const SAFE_ENV_KEYS: readonly string[] = [
  // POSIX
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TZ',
  'USER',
  'LOGNAME',
  'TMPDIR',
  // Windows
  'SystemRoot',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // Network / proxy
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
];

/**
 * Build the env passed to claude.exe. Strategy: start from a deny-by-default
 * baseline (only SAFE_ENV_KEYS), then layer required values + caller
 * overrides. Anything else from the Electron process (NODE_OPTIONS,
 * ELECTRON_RUN_AS_NODE, etc.) is dropped on the floor.
 */
export function buildSpawnEnv(opts: {
  configDir: string;
  envOverrides?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (v != null) env[key] = v;
  }

  // Required: isolate config so we never pollute the user's ~/.claude.
  env.CLAUDE_CONFIG_DIR = opts.configDir;

  // Identifies us in server-side logs.
  env.CLAUDE_CODE_ENTRYPOINT = env.CLAUDE_CODE_ENTRYPOINT ?? 'agentory-desktop';

  // Caller overrides win — this is where ANTHROPIC_BASE_URL /
  // ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_SKIP_AUTH_LOGIN come in.
  if (opts.envOverrides) {
    for (const [k, v] of Object.entries(opts.envOverrides)) {
      env[k] = v;
    }
  }

  // Defensive: even if a caller smuggled these in via overrides, strip the
  // two known Electron poisons before exec.
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

  constructor(
    private readonly child: ChildProcess,
    private readonly killGraceMs: number,
    signal: AbortSignal | undefined
  ) {
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
        // Schedule on next tick so the caller can attach listeners first.
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
}

/**
 * Spawn a claude.exe child wired up for stream-json IO. Throws synchronously
 * on bad inputs (missing configDir, missing binary). Process-level failures
 * (ENOENT after spawn) surface via `wait()` resolving with code -1.
 */
export async function spawnClaude(opts: SpawnOpts): Promise<ClaudeProcess> {
  if (!opts.configDir || opts.configDir.trim().length === 0) {
    throw new Error(
      'spawnClaude: configDir is required (caller must pass an isolated CLAUDE_CONFIG_DIR path, e.g. <userData>/claude-cli-config)'
    );
  }

  const binaryPath = opts.binaryPath ?? (await resolveClaudeBinary());
  const args = buildSpawnArgs({
    resumeId: opts.resumeId,
    permissionMode: opts.permissionMode,
    model: opts.model,
  });
  const env = buildSpawnEnv({
    configDir: opts.configDir,
    envOverrides: opts.envOverrides,
  });

  const child = spawn(binaryPath, args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Never `shell: true` — binaryPath is a full path on Windows so .cmd
    // shims work without the shell, and avoiding the shell removes argv
    // escaping landmines.
    shell: false,
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
};

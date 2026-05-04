// Per-OS spawn ARGV contract for the `claude` CLI subprocess — spec
// ch06 §1 (FOREVER-STABLE, ship-gate (c) prerequisite). Pure decider:
// takes the platform + the user-requested `claude` args, returns the
// `(file, args)` pair the pty-host child will hand to `node-pty.spawn`.
//
// This is the argv-side companion to `spawn-env.ts`:
//
//   - `spawn-env.ts`  — what env vars land in the child env  (T4.1)
//   - `spawn-argv.ts` — what binary + args node-pty actually launches (T4.2)
//
// Why a separate decider:
//   - SRP: env-shaping and argv-shaping are independent concerns; a
//     reviewer can validate either against ch06 §1 without crossing into
//     the other module's failure modes.
//   - Testability: argv shaping is platform-parameterizable as a pure
//     function — no need to spawn a real shell to assert "Windows wraps
//     the command in `cmd /c chcp 65001 >nul && claude.exe ...`".
//   - v0.4 zero-rework: multi-principal helpers in v0.4 will need to wrap
//     `claude` argv (e.g. `sudo -u <principal> claude ...` on linux) and
//     can compose around this decider without re-implementing the
//     Windows codepage step.
//
// Spec quote (ch06 §1, 2026-05-03 daemon-split-design.md L1483):
//
// > Windows: pre-spawn run `chcp 65001` in the same console session via
// > `node-pty`'s `cols`/`rows` initialization wrapper (the pty-host writes
// > `cmd /c chcp 65001 >nul && claude.exe ...` as the spawn argv when on
// > Windows), AND set env `PYTHONIOENCODING=utf-8` for any subprocess
// > `claude` may spawn that respects it.

/**
 * The shape `node-pty.spawn(file, args, opts)` consumes. `file` is the
 * absolute or PATH-resolvable executable name; `args` is the argv tail
 * (NOT including `argv[0]`).
 *
 * On POSIX this is just `claude` + the caller-supplied tail.
 * On Windows the file becomes `cmd.exe` and the args are the
 * `/c chcp 65001 >nul && claude.exe ...` chain — see {@link computeSpawnArgv}.
 */
export interface SpawnArgvResult {
  /** Executable to launch (passed as `file` to `node-pty.spawn`). */
  readonly file: string;
  /** Argv tail (passed as `args` to `node-pty.spawn`). */
  readonly args: readonly string[];
}

/** Inputs for {@link computeSpawnArgv}. */
export interface SpawnArgvOptions {
  /** `process.platform` of the running daemon — passed in for testability. */
  readonly platform: NodeJS.Platform;
  /**
   * Argv tail the user requested for the `claude` CLI. Does NOT include
   * `argv[0]` (the decider chooses that itself per platform). Empty array
   * is allowed and corresponds to `claude` with no extra args.
   */
  readonly claudeArgs: readonly string[];
  /**
   * Override the binary name. Defaults to `'claude'` on POSIX and
   * `'claude.exe'` on Windows. Tests pass an absolute path; production
   * callers will eventually pass a resolved path from a `which`-style
   * lookup (out of scope for this decider — it is a pure shape function).
   */
  readonly claudeBinary?: string;
}

/**
 * Default binary name the spec pins for the `claude` CLI.
 *
 * On Windows the spec example uses `claude.exe`; the `.exe` is required
 * inside the `cmd /c ...` chain because `cmd` performs its own PATHEXT
 * resolution that differs from node-pty's direct CreateProcess call.
 * Hard-coding `.exe` keeps the chain self-contained.
 */
export const DEFAULT_CLAUDE_BINARY_POSIX = 'claude';
export const DEFAULT_CLAUDE_BINARY_WIN32 = 'claude.exe';

/**
 * Windows codepage step the spec pins (`chcp 65001` = UTF-8). Exported
 * so tests can assert "the chain begins with chcp 65001" without re-
 * stringifying it.
 */
export const WIN32_CODEPAGE_STEP = 'chcp 65001 >nul';

/**
 * Compute the `(file, args)` pair `node-pty.spawn` will be called with,
 * per ch06 §1.
 *
 * Linux + macOS:
 *   `file = 'claude'`, `args = [...claudeArgs]`
 *
 * Windows:
 *   `file = 'cmd.exe'`,
 *   `args = ['/d', '/s', '/c', 'chcp 65001 >nul && claude.exe <claudeArgs...>']`
 *
 *   - `/d` — skip AutoRun registry entries (deterministic across hosts
 *     where users have set `cmd.exe` AutoRun macros).
 *   - `/s` — strip outer quotes per `cmd /?` rules so the chain after
 *     `/c` is a single command line, not parsed as one big quoted arg.
 *   - `/c` — execute the command then terminate cmd.
 *   - `chcp 65001 >nul` — switch the console codepage to UTF-8; output
 *     redirected to NUL so the `Active code page: 65001` chatter does
 *     not pollute the PTY stream the daemon snapshots from.
 *   - `&&` — only run `claude.exe` if `chcp` succeeded (it always should,
 *     but if not we want the failure visible as a non-zero exit, not
 *     `claude` running with the wrong codepage).
 *
 * Args after `claude.exe` are quoted with double-quotes and any embedded
 * `"` is escaped as `\"`, the only escaping `cmd.exe` honors inside the
 * `/c` argument. Args that contain `&`, `|`, `<`, `>`, `^`, `(`, `)`, or
 * spaces MUST be quoted; we quote everything for simplicity (cmd treats
 * an unnecessarily-quoted arg the same as an unquoted one).
 *
 * NOTE: Windows shell-escaping is famously underspecified. The escaping
 * rules above are the conservative subset that works for `cmd /c` (NOT
 * for PowerShell, NOT for `CreateProcess` directly). Since the spec
 * mandates `cmd /c`, that is what we target.
 */
export function computeSpawnArgv(opts: SpawnArgvOptions): SpawnArgvResult {
  if (opts.platform === 'win32') {
    const claudeBin = opts.claudeBinary ?? DEFAULT_CLAUDE_BINARY_WIN32;
    const quoted = [claudeBin, ...opts.claudeArgs]
      .map(quoteForCmd)
      .join(' ');
    const chain = `${WIN32_CODEPAGE_STEP} && ${quoted}`;
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', chain],
    };
  }

  // Linux + macOS + every other POSIX platform: spawn `claude` directly.
  // No shell wrapper — node-pty's `node-pty.spawn(file, args)` calls
  // posix_spawn under the hood, which inherits the parent's locale env
  // (set by `spawn-env.ts`).
  const claudeBin = opts.claudeBinary ?? DEFAULT_CLAUDE_BINARY_POSIX;
  return {
    file: claudeBin,
    args: [...opts.claudeArgs],
  };
}

/**
 * Quote a single token for inclusion in a `cmd.exe /c` command line.
 * Always wraps in double-quotes so the caller doesn't have to think
 * about which characters are special; embedded `"` is escaped as `\"`.
 *
 * This is intentionally NOT `JSON.stringify`-style escaping — cmd does
 * not honor `\\` or `\n`, only `\"` inside a double-quoted segment.
 */
function quoteForCmd(token: string): string {
  // Empty token is rare but legal (e.g. `claude.exe ""` to pass an empty
  // positional). Keep it as `""` to round-trip.
  if (token.length === 0) return '""';
  const escaped = token.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

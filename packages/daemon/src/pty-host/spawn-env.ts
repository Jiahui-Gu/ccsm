// UTF-8 spawn env contract — spec ch06 §1 (FOREVER-STABLE, ship-gate (c)
// prerequisite). Pure decider: takes the inherited env + platform, returns
// the env that the pty-host child will pass to `node-pty.spawn(claude)`.
//
// T4.1 ships only the env subset (key/value overrides). The Windows
// `chcp 65001` argv wrapper is not assembled here — argv shaping is the
// child's job and lands with T4.2 (per-OS spawn argv contract). Keeping
// the env logic separate means: (a) the unit test surface for "what bytes
// land in env" is platform-parameterizable without spawning a real shell,
// and (b) v0.4 multi-principal helpers can call this same function with a
// different inherited env without any code duplication.
//
// SRP: one decider — `(inheritedEnv, platform, [extra]) → env-record`.
// No I/O, no probes (the macOS `locale -a` probe lives in the daemon
// startup path; the result is passed in via `darwinFallbackLocale`).

/**
 * Per-platform contract result. The keys here are exactly the env keys
 * the spec requires the pty-host child to override; the contract is
 * "these keys take these values regardless of the inherited env".
 *
 * Linux + macOS: `LANG = LC_ALL = <utf8 locale>`. macOS may need the
 * `en_US.UTF-8` fallback if `C.UTF-8` is not registered on the host —
 * the daemon probes once at startup and passes the resolved locale in
 * via {@link Utf8EnvOptions.darwinFallbackLocale}.
 *
 * Windows: `PYTHONIOENCODING=utf-8` for any subprocess `claude` may
 * spawn that respects it. The `chcp 65001` step is argv-side, not
 * env-side — it lands in T4.2.
 */
export interface Utf8EnvOptions {
  /** `process.platform` of the running daemon — passed in for testability. */
  readonly platform: NodeJS.Platform;
  /** The env to start from (typically `process.env`). */
  readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
  /** macOS fallback locale name; defaults to `'C.UTF-8'`. The daemon's
   *  startup probe (`locale -a | grep -F C.UTF-8`) computes this once
   *  and caches it; this function never touches the filesystem. */
  readonly darwinFallbackLocale?: string;
  /** Optional caller-provided env additions (v0.4 per-principal). Lower
   *  precedence than the UTF-8 contract keys, higher than inherited env. */
  readonly envExtra?: Readonly<Record<string, string>>;
}

/**
 * The UTF-8 contract keys the spec pins. Exported so tests can assert
 * "every contract key landed in the result" without re-listing them.
 */
export const UTF8_CONTRACT_KEYS_POSIX = ['LANG', 'LC_ALL'] as const;
export const UTF8_CONTRACT_KEYS_WIN32 = ['PYTHONIOENCODING'] as const;

/**
 * Compute the spawn env for the `claude` CLI subprocess per ch06 §1.
 *
 * Precedence (lowest → highest):
 *   1. Inherited env (caller passes `process.env`).
 *   2. `envExtra` (caller-provided additions; v0.4 per-principal).
 *   3. UTF-8 contract overrides (the keys in
 *      `UTF8_CONTRACT_KEYS_POSIX` / `UTF8_CONTRACT_KEYS_WIN32`) —
 *      ALWAYS win, regardless of what the inherited env said.
 *
 * Undefined values from `inheritedEnv` are dropped (Node's child_process
 * APIs accept `Record<string, string>`, not `... | undefined`).
 */
export function computeUtf8SpawnEnv(opts: Utf8EnvOptions): Record<string, string> {
  const out: Record<string, string> = {};

  // Pass 1: inherited (drop undefineds).
  for (const [k, v] of Object.entries(opts.inheritedEnv)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }

  // Pass 2: envExtra wins over inherited.
  if (opts.envExtra) {
    for (const [k, v] of Object.entries(opts.envExtra)) {
      out[k] = v;
    }
  }

  // Pass 3: UTF-8 contract wins over both.
  if (opts.platform === 'win32') {
    out.PYTHONIOENCODING = 'utf-8';
  } else if (opts.platform === 'darwin') {
    const locale = opts.darwinFallbackLocale ?? 'C.UTF-8';
    out.LANG = locale;
    out.LC_ALL = locale;
  } else {
    // Linux + every other POSIX platform falls through here per spec
    // ch06 §1 (the daemon currently only ships on linux/darwin/win32 but
    // the spec wording says "linux + macOS" → POSIX behavior is the
    // safer default for any future BSD/illumos sea targets).
    out.LANG = 'C.UTF-8';
    out.LC_ALL = 'C.UTF-8';
  }

  return out;
}

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, dirname, resolve as resolvePath } from 'node:path';

const INSTALL_HINT =
  'Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code';

/**
 * How to actually invoke claude on this machine.
 *
 *   - `direct`: spawn `path` with no shell. Safe on POSIX, and on Windows
 *     when `path` is a real `.exe`.
 *   - `node-script`: spawn `node` with `[script, ...args]`. Used when we
 *     parsed an old npm `.cmd` shim of the form
 *     `"%dp0%\node.exe" "%dp0%\node_modules\foo\bin.js" %*`.
 *   - `cmd-shell`: spawn the `.cmd`/`.bat` via `shell: true`. Last-resort
 *     fallback when we can't unwrap the shim — required because of Node's
 *     CVE-2024-27980 fix (Node 18.20.2+/20.12.2+/21.7.3+) which refuses to
 *     spawn `.cmd` files without `shell: true`. Caller MUST quote/escape
 *     argv (see `quoteCmdArg`).
 */
export type ResolvedInvocation =
  | { kind: 'direct'; path: string }
  | { kind: 'node-script'; node: string; script: string }
  | { kind: 'cmd-shell'; path: string };

/**
 * Locate the Claude CLI executable. Returns the *resolved string path* the
 * platform's `which`/`where` would surface — for back-compat with callers
 * (and tests) that just need to know "is it on PATH". Use
 * `resolveClaudeInvocation()` if you actually want to spawn it.
 */
export async function resolveClaudeBinary(): Promise<string> {
  const override = process.env.AGENTORY_CLAUDE_BIN;
  if (override && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `AGENTORY_CLAUDE_BIN points to a non-existent file: ${override}`
      );
    }
    return override;
  }

  const isWin = process.platform === 'win32';
  const tool = isWin ? 'where' : 'which';

  const found = await runLookup(tool, 'claude');
  if (found) return found;

  throw new Error(INSTALL_HINT);
}

/**
 * Resolve claude into a *spawnable* form. On Windows, `where claude` returns
 * a `.cmd` shim by default; spawning that with `shell: false` blows up on
 * patched Node (CVE-2024-27980), so we try to unwrap it into the underlying
 * `.exe` (or `node` + `.js`). If unwrap fails we fall back to `cmd-shell`
 * mode and let the spawner take responsibility for argv escaping.
 */
export async function resolveClaudeInvocation(): Promise<ResolvedInvocation> {
  const path = await resolveClaudeBinary();
  return classifyInvocation(path);
}

export function classifyInvocation(path: string): ResolvedInvocation {
  // Non-Windows platforms have nothing shim-shaped to worry about; spawn
  // a `claude` shell script directly via the OS loader.
  if (process.platform !== 'win32') return { kind: 'direct', path };

  const lower = path.toLowerCase();
  if (lower.endsWith('.exe')) return { kind: 'direct', path };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const unwrapped = parseCmdShim(path);
    if (unwrapped) return unwrapped;
    return { kind: 'cmd-shell', path };
  }
  // Bare path on Windows (shouldn't happen via `where`) — let it through.
  return { kind: 'direct', path };
}

/**
 * Parse an npm-generated `.cmd` shim and find the underlying executable.
 *
 * Recognized forms:
 *   1. Native binary forwarder (current claude-code 2.x):
 *        "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
 *   2. Classic node-script shim (older npm):
 *        "%dp0%\node.exe"  "%dp0%\node_modules\foo\cli.js" %*
 *      or with a system `node`:
 *        node  "%dp0%\node_modules\foo\cli.js" %*
 *
 * Returns `null` if we can't recognize the shape — caller falls back to
 * `cmd-shell` mode.
 */
export function parseCmdShim(cmdPath: string): ResolvedInvocation | null {
  let body: string;
  try {
    body = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dp0 = dirname(cmdPath);
  const expand = (s: string): string =>
    s.replace(/%dp0%\\?/gi, dp0 + '\\').replace(/%~dp0%?\\?/gi, dp0 + '\\');

  // Look for the line that actually does the exec — anything quoted or
  // bare ending with .exe / .js followed by %*.
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('@') || line.startsWith(':') ||
        line.toUpperCase().startsWith('REM') ||
        line.toUpperCase().startsWith('SET ') ||
        line.toUpperCase().startsWith('CALL ') ||
        line.toUpperCase().startsWith('GOTO ') ||
        line.toUpperCase().startsWith('IF ') ||
        line.toUpperCase().startsWith('ENDLOCAL') ||
        line.toUpperCase().startsWith('SETLOCAL') ||
        line.toUpperCase().startsWith('EXIT')) {
      continue;
    }

    // Pull out quoted-or-bare tokens.
    const tokens: string[] = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      tokens.push(m[1] ?? m[2]);
    }
    if (tokens.length === 0) continue;

    const first = expand(tokens[0]);
    const firstLower = first.toLowerCase();

    // Form 1: a single .exe call.
    if (firstLower.endsWith('.exe')) {
      const abs = isAbsolute(first) ? first : resolvePath(dp0, first);
      // If it's node + .js arg, treat as node-script.
      if (/(^|[\\/])node\.exe$/i.test(abs) && tokens.length >= 2) {
        const script = expand(tokens[1]);
        const scriptAbs = isAbsolute(script) ? script : resolvePath(dp0, script);
        if (scriptAbs.toLowerCase().endsWith('.js') && existsSync(scriptAbs)) {
          return { kind: 'node-script', node: abs, script: scriptAbs };
        }
      }
      if (existsSync(abs)) return { kind: 'direct', path: abs };
      return null;
    }

    // Form 2: bare `node` + script.
    if (/^node$/i.test(first) && tokens.length >= 2) {
      const script = expand(tokens[1]);
      const scriptAbs = isAbsolute(script) ? script : resolvePath(dp0, script);
      if (scriptAbs.toLowerCase().endsWith('.js') && existsSync(scriptAbs)) {
        // Use bare 'node' — caller will rely on PATH to resolve it.
        return { kind: 'node-script', node: 'node', script: scriptAbs };
      }
    }
  }
  return null;
}

/**
 * Quote a single argv token for cmd.exe consumption. Used only when we
 * can't avoid `shell: true` (i.e. unrecognized .cmd shim on Windows).
 *
 * Strategy:
 *   1. Backslash-escape internal `"` (CommandLineToArgvW rules).
 *   2. Wrap in `"..."`.
 *   3. Caret-escape cmd.exe metacharacters that survive the quoted layer
 *      (cmd.exe parses `^` first, then strips quotes for redirection
 *      operators in some edge cases). Better safe than RCE-sorry.
 */
export function quoteCmdArg(arg: string): string {
  // Step 1: handle backslashes preceding quotes per CRT rules.
  // Each `\` before a `"` doubles; each `"` becomes `\"`.
  let out = '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2) + '\\"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2); // trailing backslashes before closing "
  out = `"${out}"`;
  // Step 2: caret-escape cmd.exe specials. Even inside double quotes, a few
  // characters can be interpreted by the shell after variable expansion;
  // caret-prefixing them is harmless inside quotes and defends against
  // delayed-expansion / redirection edge cases.
  out = out.replace(/([\^&|<>()%!])/g, '^$1');
  return out;
}

function runLookup(tool: string, target: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child;
    try {
      child = spawn(tool, [target], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        // No shell: keeps argument handling deterministic across platforms.
        shell: false,
      });
    } catch {
      done(null);
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) {
        done(null);
        return;
      }
      // `where` may print multiple paths (one per line). Pick the first
      // existing one — it's what cmd.exe would actually invoke.
      const candidates = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .filter((s) => existsSync(s));

      // On Windows, `where` happily lists POSIX-style extensionless shims
      // (e.g. `C:\path\claude` from npm install — a bash script that
      // CreateProcessW can't execute). Filter to PATHEXT-matching entries
      // first; only fall back to whatever `where` returned if none of
      // them are executable extensions.
      if (process.platform === 'win32' && candidates.length > 0) {
        const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.toLowerCase())
          .filter((e) => e.length > 0);
        const executable = candidates.find((c) => {
          const lc = c.toLowerCase();
          return exts.some((ext) => lc.endsWith(ext));
        });
        if (executable) {
          done(executable);
          return;
        }
      }

      if (candidates.length > 0) {
        done(candidates[0]);
        return;
      }
      done(null);
    });
  });
}

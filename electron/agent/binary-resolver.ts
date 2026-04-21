import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const INSTALL_HINT =
  'Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code';

/**
 * Locate the Claude CLI executable.
 *
 * Resolution order:
 *   1. `AGENTORY_CLAUDE_BIN` environment variable (must be an existing file).
 *   2. Platform lookup: `where claude` on Windows, `which claude` elsewhere.
 *      On Windows we deliberately let `where` resolve `.cmd` / `.exe` to a
 *      *full path* — the spawn layer never uses `shell: true`, so a bare
 *      `claude` would not find the npm-installed `.cmd` shim.
 *
 * Throws an Error containing the install hint when nothing is found.
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
        .filter((s) => s.length > 0);
      for (const c of candidates) {
        if (existsSync(c)) {
          done(c);
          return;
        }
      }
      done(null);
    });
  });
}

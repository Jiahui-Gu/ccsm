import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Cap on the number of frames we'll return to the renderer. Some historical
// transcripts are huge (hundreds of MB / tens of thousands of frames). We
// already accept this on the agent stream path because the user is the one
// generating it, but on import we're asked to materialize the whole thing
// at once. Cap defensively — well past anything a typical session generates,
// while still bounding memory for pathological cases.
const MAX_FRAMES = 50_000;

// `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — read line-by-line,
// JSON-parse each, return the resulting frames. Filename is constrained to
// the sessionId we got back from `import:scan`, which is itself derived from
// a directory listing of `~/.claude/projects/<encoded-cwd>/`, so there's no
// renderer-controlled path component beyond the projectDir we already
// accepted at scan time.
//
// We deliberately do NOT do block translation here — that lives in the
// renderer (`stream-to-blocks`) and is shared with the live agent path.
// Keeping this main-side read as raw-frames means the conversion logic has
// exactly one home.
export async function loadImportableHistory(
  projectDir: string,
  sessionId: string
): Promise<unknown[]> {
  // Reject any path component that would let a malicious renderer break out
  // of `~/.claude/projects/`. `path.basename` strips traversal but accepting
  // an unsanitized projectDir would still let `..` slip past on Windows. We
  // lock both to a leaf segment.
  const safeProj = path.basename(String(projectDir ?? ''));
  const safeSid = path.basename(String(sessionId ?? ''));
  if (!safeProj || !safeSid) return [];
  if (safeProj.includes('..') || safeSid.includes('..')) return [];
  const file = path.join(PROJECTS_ROOT, safeProj, `${safeSid}.jsonl`);
  // Ensure the resolved path is still inside PROJECTS_ROOT — defense in depth
  // against any encoding tricks `basename` might miss on a future Node.
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(PROJECTS_ROOT) + path.sep)) return [];
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  return new Promise((resolve) => {
    const stream = fs.createReadStream(resolved, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const out: unknown[] = [];
    let count = 0;
    const finish = () => {
      rl.removeAllListeners();
      stream.destroy();
      resolve(out);
    };
    rl.on('line', (line) => {
      if (!line) return;
      if (count >= MAX_FRAMES) {
        finish();
        return;
      }
      count++;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip malformed lines — same as the streaming agent parser
      }
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

export type ScannableSession = {
  sessionId: string;
  cwd: string;
  title: string;
  mtime: number;
  projectDir: string;
  model: string | null;
};

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Read just enough of the head of a jsonl to determine cwd + a usable title.
// CLI-written transcripts can be hundreds of MB; we never read the whole file.
const MAX_HEAD_LINES = 200;

export async function scanImportableSessions(): Promise<ScannableSession[]> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(PROJECTS_ROOT);
  } catch {
    return [];
  }

  const out: ScannableSession[] = [];
  for (const dir of dirs) {
    const projDir = path.join(PROJECTS_ROOT, dir);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(projDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      const full = path.join(projDir, f);
      try {
        const head = await readHead(full);
        if (!head) continue;
        const stat = await fs.promises.stat(full);
        out.push({
          sessionId,
          cwd: head.cwd,
          title: head.title,
          mtime: stat.mtimeMs,
          projectDir: dir,
          model: head.model
        });
      } catch {
        // skip unreadable / malformed files
      }
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

type Head = { cwd: string; title: string; model: string | null };

function readHead(file: string): Promise<Head | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let cwd = '';
    let aiTitle = '';
    let firstUserText = '';
    let model: string | null = null;
    let lines = 0;
    const finish = () => {
      rl.removeAllListeners();
      stream.destroy();
      const title = aiTitle || firstUserText || '(untitled session)';
      if (!cwd && !aiTitle && !firstUserText && !model) {
        resolve(null);
        return;
      }
      resolve({ cwd: cwd || '~', title, model });
    };
    rl.on('line', (line) => {
      lines++;
      if (lines > MAX_HEAD_LINES) {
        finish();
        return;
      }
      if (!line) return;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof d.cwd === 'string' && !cwd) cwd = d.cwd;
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string') {
        aiTitle = d.aiTitle;
      }
      if (!firstUserText && d.type === 'user' && d.message) {
        const txt = extractUserText(d.message);
        if (txt) firstUserText = truncate(txt, 80);
      }
      if (!model) {
        const m = extractModel(d);
        if (m) model = m;
      }
      if (cwd && aiTitle && model) {
        finish();
      }
    });
    rl.on('close', finish);
    rl.on('error', () => resolve(null));
  });
}

function extractUserText(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return cleanCommandWrapper(c);
  if (!Array.isArray(c)) return '';
  for (const part of c) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      const cleaned = cleanCommandWrapper(part.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// Slash-command lines are wrapped in <command-name>...</command-name> XML and
// look like noise as titles. Skip them.
function cleanCommandWrapper(text: string): string {
  if (text.startsWith('<command-')) return '';
  return text.trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Derive a deduped list of recently-used cwds from a (presumably mtime-sorted)
 * scan result. Most-recent first, dropping the placeholder `~` entries the
 * scanner emits when no `cwd` field was found in the transcript head — those
 * would default the picker to the user's home dir, which is rarely useful.
 * Caps at `max` entries so the dropdown stays a reasonable length.
 */
export function deriveRecentCwds(
  sessions: ReadonlyArray<Pick<ScannableSession, 'cwd' | 'mtime'>>,
  max = 10
): string[] {
  const ordered = [...sessions].sort((a, b) => b.mtime - a.mtime);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of ordered) {
    const cwd = s.cwd;
    if (!cwd || cwd === '~') continue;
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    out.push(cwd);
    if (out.length >= max) break;
  }
  return out;
}

// Pure head-parsing helper, exported for unit testing. Given an array of jsonl
// lines (already parsed-back-to-strings or raw), return the same Head shape
// the streaming reader produces.
export function parseHead(lines: string[]): Head | null {
  let cwd = '';
  let aiTitle = '';
  let firstUserText = '';
  let model: string | null = null;
  for (let i = 0; i < lines.length && i < MAX_HEAD_LINES; i++) {
    const line = lines[i];
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d.cwd === 'string' && !cwd) cwd = d.cwd;
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') aiTitle = d.aiTitle;
    if (!firstUserText && d.type === 'user' && d.message) {
      const txt = extractUserText(d.message);
      if (txt) firstUserText = truncate(txt, 80);
    }
    if (!model) {
      const m = extractModel(d);
      if (m) model = m;
    }
    if (cwd && aiTitle && model) break;
  }
  if (!cwd && !aiTitle && !firstUserText && !model) return null;
  const title = aiTitle || firstUserText || '(untitled session)';
  return { cwd: cwd || '~', title, model };
}

// CLI transcripts carry the model on assistant frames as `message.model`.
// Some older / synthetic frames may put it at the top level — accept both.
function extractModel(d: any): string | null {
  if (typeof d?.message?.model === 'string' && d.message.model) return d.message.model;
  if (typeof d?.model === 'string' && d.model) return d.model;
  return null;
}

/**
 * Most-frequently-observed model across the (presumably mtime-sorted) recent
 * `max` sessions. Ties broken by most-recent occurrence so a model the user
 * just switched to wins over a stale historical favourite. Returns null on
 * empty input or when no session carries a model.
 */
export function deriveTopModel(
  sessions: ReadonlyArray<Pick<ScannableSession, 'model' | 'mtime'>>,
  max = 50
): string | null {
  if (sessions.length === 0) return null;
  const ordered = [...sessions].sort((a, b) => b.mtime - a.mtime).slice(0, max);
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  for (const s of ordered) {
    if (!s.model) continue;
    counts.set(s.model, (counts.get(s.model) ?? 0) + 1);
    if (!lastSeen.has(s.model)) lastSeen.set(s.model, s.mtime);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  let bestSeen = -Infinity;
  for (const [m, c] of counts) {
    const seen = lastSeen.get(m) ?? 0;
    if (c > bestCount || (c === bestCount && seen > bestSeen)) {
      best = m;
      bestCount = c;
      bestSeen = seen;
    }
  }
  return best;
}

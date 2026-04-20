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
          projectDir: dir
        });
      } catch {
        // skip unreadable / malformed files
      }
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

type Head = { cwd: string; title: string };

function readHead(file: string): Promise<Head | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let cwd = '';
    let aiTitle = '';
    let firstUserText = '';
    let lines = 0;
    const finish = () => {
      rl.removeAllListeners();
      stream.destroy();
      const title = aiTitle || firstUserText || '(untitled session)';
      if (!cwd && !aiTitle && !firstUserText) {
        resolve(null);
        return;
      }
      resolve({ cwd: cwd || '~', title });
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
      if (cwd && aiTitle) {
        // We've got the best possible title; stop early.
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

// Pure head-parsing helper, exported for unit testing. Given an array of jsonl
// lines (already parsed-back-to-strings or raw), return the same Head shape
// the streaming reader produces.
export function parseHead(lines: string[]): Head | null {
  let cwd = '';
  let aiTitle = '';
  let firstUserText = '';
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
    if (cwd && aiTitle) break;
  }
  if (!cwd && !aiTitle && !firstUserText) return null;
  const title = aiTitle || firstUserText || '(untitled session)';
  return { cwd: cwd || '~', title };
}

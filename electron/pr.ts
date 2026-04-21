// /pr slash-command main-process helpers.
//
// Shape of the flow:
//   preflight -> (renderer shows form) -> create -> poll CI checks.
//
// Everything that touches `child_process.spawn` is kept here so the
// renderer stays sandboxed. Pure helpers (body generation, CI state
// aggregation, gh-missing-install-hint) are exported so unit tests can
// exercise them without mocking spawn.

import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Shared types — mirrored in the renderer via IPC.
// ---------------------------------------------------------------------------

export type PreflightError =
  | { code: 'no-cwd'; detail: string }
  | { code: 'not-git'; detail: string }
  | { code: 'no-gh'; detail: string }
  | { code: 'on-default-branch'; detail: string; branch: string }
  | { code: 'dirty-tree'; detail: string }
  | { code: 'no-commits'; detail: string };

export type PreflightResult =
  | {
      ok: true;
      branch: string;
      base: string;
      availableBases: string[];
      repoRoot: string;
      suggestedTitle: string;
      suggestedBody: string;
    }
  | { ok: false; errors: PreflightError[] };

export type CreatePrArgs = {
  cwd: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};

export type CreatePrResult =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string };

export type CheckState = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending';
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'neutral'
  | 'action_required'
  | null;

export interface PrCheck {
  name: string;
  status: CheckState;
  conclusion: CheckConclusion;
  detailsUrl?: string;
}

export type ChecksResult =
  | { ok: true; checks: PrCheck[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without spawn).
// ---------------------------------------------------------------------------

export const PR_BODY_FOOTER =
  '\n\n---\nGenerated with [agentory-next](https://github.com/Jiahui-Gu/Agentory-next).';

// Canonical set of branch names we consider "default". If the user is on
// one of these we refuse to open a PR from it back into itself — that's
// the shape of mistakes worth blocking. `trunk` is in there for older Git
// shops; `develop` is NOT because many flows legitimately branch off it.
export const DEFAULT_BRANCH_NAMES = new Set(['main', 'master', 'trunk']);

export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCH_NAMES.has(branch);
}

export function buildPrBody(options: {
  commitSummaries: string[]; // one line per commit since base, freshest last
  title: string;
}): string {
  const { commitSummaries, title } = options;
  const sectionTitle = '## Summary';
  if (commitSummaries.length === 0) {
    return `${sectionTitle}\n\n- ${title}${PR_BODY_FOOTER}`;
  }
  // De-dup exact-match summary lines while preserving first-seen order.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of commitSummaries) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(`- ${trimmed}`);
  }
  return `${sectionTitle}\n\n${lines.join('\n')}${PR_BODY_FOOTER}`;
}

export type AggregateState =
  | 'pending' // at least one check still running / queued
  | 'passing' // all completed AND conclusion in {success, skipped, neutral}
  | 'failing' // any conclusion in {failure, cancelled, timed_out, action_required}
  | 'empty'; // zero checks reported by gh (common for brand-new PRs before CI registers)

export function aggregateChecks(checks: PrCheck[]): AggregateState {
  if (checks.length === 0) return 'empty';
  let hasIncomplete = false;
  for (const c of checks) {
    if (c.status !== 'completed') {
      hasIncomplete = true;
      continue;
    }
    const conc = c.conclusion;
    if (
      conc === 'failure' ||
      conc === 'cancelled' ||
      conc === 'timed_out' ||
      conc === 'action_required'
    ) {
      return 'failing';
    }
  }
  return hasIncomplete ? 'pending' : 'passing';
}

export function formatGhInstallHint(): string {
  // Keep this short — renderer wraps it in a status block. Platform-specific
  // install lines come from gh's own docs and match what the CLI prints.
  const platform = process.platform;
  const base = 'The GitHub CLI (`gh`) is required to open PRs.';
  if (platform === 'win32') {
    return `${base} Install with: winget install --id GitHub.cli    (or: choco install gh)`;
  }
  if (platform === 'darwin') {
    return `${base} Install with: brew install gh`;
  }
  return `${base} See https://cli.github.com/ for install instructions.`;
}

// ---------------------------------------------------------------------------
// Spawn helpers.
// ---------------------------------------------------------------------------

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  // True if the binary could not be located at all (ENOENT-class error).
  notFound?: boolean;
}

// Thin, promise-returning wrapper over child_process.spawn. Explicit
// (non-shell) argv so we don't need to quote anything ourselves — the
// shell is never involved, so there's nothing for the user's title /
// body to break out of.
export function runCommand(
  cmd: string,
  args: string[],
  opts: SpawnOptionsWithoutStdio & { input?: string; timeoutMs?: number } = {}
): Promise<SpawnResult> {
  return _runner(cmd, args, opts);
}

// Test seam. Production callers never override this; unit tests swap it
// to a pure function so they can assert preflight / create behavior
// without actually spawning processes.
type Runner = (
  cmd: string,
  args: string[],
  opts: SpawnOptionsWithoutStdio & { input?: string; timeoutMs?: number }
) => Promise<SpawnResult>;

let _runner: Runner = defaultRunner;

export function _setRunner(r: Runner | null): void {
  _runner = r ?? defaultRunner;
}

function defaultRunner(
  cmd: string,
  args: string[],
  opts: SpawnOptionsWithoutStdio & { input?: string; timeoutMs?: number }
): Promise<SpawnResult> {
  const { input, timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { ...spawnOpts, shell: false });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        code: -1,
        stdout: '',
        stderr: e.message ?? String(err),
        notFound: e.code === 'ENOENT'
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (res: SpawnResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
        finish({ code: -1, stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]` });
      }, timeoutMs);
    }

    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      finish({
        code: -1,
        stdout,
        stderr: stderr + (e.message ?? String(err)),
        notFound: e.code === 'ENOENT'
      });
    });
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr });
    });

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

// ---------------------------------------------------------------------------
// Preflight — called when the user types /pr and hits Enter.
// ---------------------------------------------------------------------------

async function gitInRepo(cwd: string, args: string[], timeoutMs = 10_000): Promise<SpawnResult> {
  return runCommand('git', args, { cwd, timeoutMs });
}

export async function runPreflight(cwd: string | null | undefined): Promise<PreflightResult> {
  const errors: PreflightError[] = [];

  if (!cwd) {
    return {
      ok: false,
      errors: [
        {
          code: 'no-cwd',
          detail: 'This session has no working directory. Set one via the session header.'
        }
      ]
    };
  }

  // git repo?
  const top = await gitInRepo(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) {
    if (top.notFound) {
      return {
        ok: false,
        errors: [
          {
            code: 'not-git',
            detail: '`git` executable not found on PATH. Install Git and retry.'
          }
        ]
      };
    }
    return {
      ok: false,
      errors: [
        {
          code: 'not-git',
          detail: `${cwd} is not inside a git repository.`
        }
      ]
    };
  }
  const repoRoot = top.stdout.trim();

  // gh installed?
  const ghVer = await runCommand('gh', ['--version'], { cwd, timeoutMs: 10_000 });
  if (ghVer.notFound || ghVer.code !== 0) {
    return {
      ok: false,
      errors: [{ code: 'no-gh', detail: formatGhInstallHint() }]
    };
  }

  // current branch
  const br = await gitInRepo(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.stdout.trim();
  if (br.code !== 0 || !branch || branch === 'HEAD') {
    return {
      ok: false,
      errors: [
        {
          code: 'not-git',
          detail: 'Detached HEAD. Check out a named branch before opening a PR.'
        }
      ]
    };
  }

  if (isDefaultBranch(branch)) {
    errors.push({
      code: 'on-default-branch',
      branch,
      detail: `You are on "${branch}". Create a feature branch first: git switch -c feat/your-change`
    });
  }

  // Working tree clean?
  const st = await gitInRepo(repoRoot, ['status', '--porcelain']);
  if (st.code === 0 && st.stdout.trim().length > 0) {
    errors.push({
      code: 'dirty-tree',
      detail: 'Uncommitted changes detected. Commit them first — `/pr` does not auto-commit.'
    });
  }

  // Resolve base branch. Prefer origin/HEAD if set (upstream default).
  let base = 'main';
  const defaultRef = await gitInRepo(repoRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD'
  ]);
  if (defaultRef.code === 0 && defaultRef.stdout.trim().startsWith('origin/')) {
    base = defaultRef.stdout.trim().slice('origin/'.length);
  } else {
    // Fallback: if origin/main exists use it, else origin/master.
    const hasMain = await gitInRepo(repoRoot, ['rev-parse', '--verify', 'origin/main']);
    if (hasMain.code === 0) base = 'main';
    else {
      const hasMaster = await gitInRepo(repoRoot, ['rev-parse', '--verify', 'origin/master']);
      if (hasMaster.code === 0) base = 'master';
    }
  }

  // List all local + remote branches for the dropdown, dedupe on short name.
  const brList = await gitInRepo(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes'
  ]);
  const availableBases = Array.from(
    new Set(
      brList.stdout
        .split(/\r?\n/)
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => (n.startsWith('origin/') ? n.slice('origin/'.length) : n))
        .filter((n) => n !== 'HEAD' && n !== branch)
    )
  ).sort();

  // Latest commit subject → suggested title.
  const subj = await gitInRepo(repoRoot, ['log', '-1', '--pretty=%s']);
  const suggestedTitle = subj.code === 0 ? subj.stdout.trim() : '';

  // Commits between base and HEAD → body summary. Use `origin/<base>..HEAD`
  // if the remote base is known; else `<base>..HEAD`.
  const refCandidates = [`origin/${base}`, base];
  let summaryLines: string[] = [];
  for (const ref of refCandidates) {
    const exists = await gitInRepo(repoRoot, ['rev-parse', '--verify', ref]);
    if (exists.code !== 0) continue;
    const log = await gitInRepo(repoRoot, [
      'log',
      `${ref}..HEAD`,
      '--pretty=format:%s',
      '--reverse'
    ]);
    if (log.code === 0) {
      summaryLines = log.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      break;
    }
  }
  if (summaryLines.length === 0 && suggestedTitle) {
    // Brand-new branch with no merge base found yet — use the latest subject.
    summaryLines = [suggestedTitle];
    errors.push({
      code: 'no-commits',
      detail:
        `Could not compute commits between "${base}" and HEAD. The PR body will use the latest commit only.`
    });
  }

  const suggestedBody = buildPrBody({
    commitSummaries: summaryLines,
    title: suggestedTitle || 'Update'
  });

  if (errors.filter((e) => e.code !== 'no-commits').length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    branch,
    base,
    availableBases,
    repoRoot,
    suggestedTitle,
    suggestedBody
  };
}

// ---------------------------------------------------------------------------
// Create PR.
// ---------------------------------------------------------------------------

const GH_PR_URL_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

export function parsePrUrl(
  text: string
): { url: string; owner: string; repo: string; number: number } | null {
  const m = text.match(GH_PR_URL_RE);
  if (!m) return null;
  return { url: m[0], owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function createPr(args: CreatePrArgs): Promise<CreatePrResult> {
  const { cwd, branch, base, title, body, draft } = args;

  // Safety: the renderer already checks isDefaultBranch via preflight, but we
  // re-check in main so an adversarial renderer can't bypass it.
  if (isDefaultBranch(branch)) {
    return { ok: false, error: `Refusing to open a PR from default branch "${branch}".` };
  }

  // Push the branch first. -u sets upstream if it isn't already.
  const push = await runCommand('git', ['push', '-u', 'origin', branch], {
    cwd,
    timeoutMs: 120_000
  });
  if (push.code !== 0) {
    const hint =
      /rejected|non-fast-forward/i.test(push.stderr)
        ? '\nRemote has commits you do not. If your rebase is intentional, consider `git push --force-with-lease`.'
        : '';
    return {
      ok: false,
      error: `git push failed (exit ${push.code}):\n${push.stderr.trim()}${hint}`
    };
  }

  // Write body to a tmpfile so we never have to escape shell-special chars.
  const tmp = path.join(os.tmpdir(), `agentory-pr-body-${Date.now()}-${process.pid}.md`);
  await fsp.writeFile(tmp, body, 'utf8');
  try {
    const ghArgs = [
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      base,
      '--title',
      title,
      '--body-file',
      tmp
    ];
    if (draft) ghArgs.push('--draft');
    const res = await runCommand('gh', ghArgs, { cwd, timeoutMs: 120_000 });
    if (res.code !== 0) {
      return {
        ok: false,
        error: `gh pr create failed (exit ${res.code}):\n${(res.stderr || res.stdout).trim()}`
      };
    }
    const parsed = parsePrUrl(res.stdout) ?? parsePrUrl(res.stderr);
    if (!parsed) {
      return {
        ok: false,
        error: `gh pr create succeeded but no PR URL was found in output:\n${res.stdout.trim()}`
      };
    }
    return { ok: true, url: parsed.url, number: parsed.number };
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CI polling.
// ---------------------------------------------------------------------------

interface GhCheckJson {
  name?: string;
  state?: string;
  status?: string;
  conclusion?: string | null;
  link?: string;
}

function normalizeState(raw: string | undefined): CheckState {
  const v = (raw ?? '').toLowerCase();
  if (v === 'queued') return 'queued';
  if (v === 'in_progress' || v === 'pending') return 'in_progress';
  if (v === 'waiting') return 'waiting';
  if (v === 'completed' || v === 'success' || v === 'fail' || v === 'failure' || v === 'skipping')
    return 'completed';
  return 'pending';
}

function normalizeConclusion(raw: string | null | undefined, state: CheckState): CheckConclusion {
  if (state !== 'completed') return null;
  const v = (raw ?? '').toLowerCase();
  if (v === 'success' || v === 'pass' || v === 'passing') return 'success';
  if (v === 'failure' || v === 'fail' || v === 'failing') return 'failure';
  if (v === 'cancelled') return 'cancelled';
  if (v === 'skipped' || v === 'skipping') return 'skipped';
  if (v === 'timed_out') return 'timed_out';
  if (v === 'neutral') return 'neutral';
  if (v === 'action_required') return 'action_required';
  return null;
}

export function parseGhChecks(stdout: string): PrCheck[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PrCheck[] = [];
  for (const raw of parsed as GhCheckJson[]) {
    const name = typeof raw?.name === 'string' ? raw.name : 'check';
    // gh has used both `state` and `status`; map either.
    const rawState = raw.state ?? raw.status;
    const status = normalizeState(rawState);
    const conclusion = normalizeConclusion(raw.conclusion, status);
    const detailsUrl = typeof raw.link === 'string' && raw.link.length > 0 ? raw.link : undefined;
    out.push({ name, status, conclusion, detailsUrl });
  }
  return out;
}

export async function fetchPrChecks(cwd: string, prNumber: number): Promise<ChecksResult> {
  const res = await runCommand(
    'gh',
    ['pr', 'checks', String(prNumber), '--json', 'name,state,conclusion,link'],
    { cwd, timeoutMs: 30_000 }
  );
  if (res.code !== 0) {
    // `gh pr checks` exits non-zero when at least one check is failing OR
    // when checks haven't been registered yet. Parse stdout anyway — a valid
    // JSON array means we have a real snapshot.
    const checks = parseGhChecks(res.stdout);
    if (checks.length > 0) return { ok: true, checks };
    return {
      ok: false,
      error: `gh pr checks exited ${res.code}: ${(res.stderr || res.stdout).trim()}`
    };
  }
  return { ok: true, checks: parseGhChecks(res.stdout) };
}

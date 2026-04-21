import { describe, it, expect, afterEach } from 'vitest';
import * as pr from '../electron/pr';

describe('buildPrBody', () => {
  it('renders the Summary header with bulleted commits (newest first order preserved)', () => {
    const body = pr.buildPrBody({
      commitSummaries: ['feat: add thing', 'fix: tweak'],
      title: 'ignored when summaries present'
    });
    expect(body).toContain('## Summary');
    expect(body).toContain('- feat: add thing');
    expect(body).toContain('- fix: tweak');
    expect(body).toContain('Generated with');
  });

  it('falls back to the title bullet when no commits are given', () => {
    const body = pr.buildPrBody({ commitSummaries: [], title: 'my PR title' });
    expect(body).toContain('- my PR title');
    expect(body).toContain('Generated with');
  });

  it('deduplicates repeated commit subjects while preserving first-seen order', () => {
    const body = pr.buildPrBody({
      commitSummaries: ['x', 'y', 'x', '', 'z', 'y'],
      title: 't'
    });
    const lines = body.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual(['- x', '- y', '- z']);
  });
});

describe('aggregateChecks', () => {
  it('returns empty for no checks', () => {
    expect(pr.aggregateChecks([])).toBe('empty');
  });
  it('returns passing when all completed with success/skipped/neutral', () => {
    expect(
      pr.aggregateChecks([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'completed', conclusion: 'skipped' },
        { name: 'c', status: 'completed', conclusion: 'neutral' }
      ])
    ).toBe('passing');
  });
  it('returns failing as soon as one check fails', () => {
    expect(
      pr.aggregateChecks([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'completed', conclusion: 'failure' }
      ])
    ).toBe('failing');
  });
  it('treats cancelled / timed_out / action_required as failing', () => {
    expect(
      pr.aggregateChecks([{ name: 'a', status: 'completed', conclusion: 'cancelled' }])
    ).toBe('failing');
    expect(
      pr.aggregateChecks([{ name: 'a', status: 'completed', conclusion: 'timed_out' }])
    ).toBe('failing');
    expect(
      pr.aggregateChecks([{ name: 'a', status: 'completed', conclusion: 'action_required' }])
    ).toBe('failing');
  });
  it('returns pending while any check is not yet completed', () => {
    expect(
      pr.aggregateChecks([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'in_progress', conclusion: null }
      ])
    ).toBe('pending');
  });
});

describe('parseGhChecks', () => {
  it('parses a typical gh pr checks --json array', () => {
    const stdout = JSON.stringify([
      { name: 'test', state: 'completed', conclusion: 'success', link: 'https://x/1' },
      { name: 'lint', state: 'in_progress', conclusion: null }
    ]);
    const checks = pr.parseGhChecks(stdout);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: 'test', status: 'completed', conclusion: 'success' });
    expect(checks[0].detailsUrl).toBe('https://x/1');
    expect(checks[1]).toMatchObject({ name: 'lint', status: 'in_progress', conclusion: null });
  });
  it('returns empty array for malformed JSON', () => {
    expect(pr.parseGhChecks('not-json')).toEqual([]);
    expect(pr.parseGhChecks('{}')).toEqual([]);
  });
});

describe('parsePrUrl', () => {
  it('extracts owner / repo / number', () => {
    const parsed = pr.parsePrUrl(
      'Creating pull request...\nhttps://github.com/acme/widgets/pull/42\n'
    );
    expect(parsed).toEqual({
      url: 'https://github.com/acme/widgets/pull/42',
      owner: 'acme',
      repo: 'widgets',
      number: 42
    });
  });
  it('returns null when no URL is present', () => {
    expect(pr.parsePrUrl('boom')).toBeNull();
  });
});

describe('isDefaultBranch', () => {
  it('recognizes main/master/trunk', () => {
    expect(pr.isDefaultBranch('main')).toBe(true);
    expect(pr.isDefaultBranch('master')).toBe(true);
    expect(pr.isDefaultBranch('trunk')).toBe(true);
  });
  it('treats feature branches as non-default', () => {
    expect(pr.isDefaultBranch('feat/slash-pr-command')).toBe(false);
    expect(pr.isDefaultBranch('develop')).toBe(false);
  });
});

describe('formatGhInstallHint', () => {
  it('returns a non-empty string mentioning gh', () => {
    const s = pr.formatGhInstallHint();
    expect(s.length).toBeGreaterThan(0);
    expect(s.toLowerCase()).toContain('gh');
  });
});

// --- Preflight unit tests (spawn is mocked) --------------------------------

type MockResp = { code: number; stdout?: string; stderr?: string; notFound?: boolean };

function makeRunner(table: Array<{ match: (cmd: string, args: string[]) => boolean; resp: MockResp }>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    for (const row of table) {
      if (row.match(cmd, args)) {
        return {
          code: row.resp.code,
          stdout: row.resp.stdout ?? '',
          stderr: row.resp.stderr ?? '',
          notFound: row.resp.notFound
        };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('runPreflight', () => {
  afterEach(() => {
    pr._setRunner(null);
  });

  it('fails when cwd is missing', async () => {
    const res = await pr.runPreflight(null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].code).toBe('no-cwd');
  });

  it('reports not-git when git rev-parse fails', async () => {
    const { runner } = makeRunner([
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse',
        resp: { code: 128, stderr: 'fatal: not a git repository' }
      }
    ]);
    pr._setRunner(runner);
    const res = await pr.runPreflight('/tmp/nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].code).toBe('not-git');
  });

  it('reports no-gh when gh binary is missing', async () => {
    const { runner } = makeRunner([
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel',
        resp: { code: 0, stdout: '/repo' }
      },
      {
        match: (cmd) => cmd === 'gh',
        resp: { code: -1, stderr: 'ENOENT', notFound: true }
      }
    ]);
    pr._setRunner(runner);
    const res = await pr.runPreflight('/repo/sub');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].code).toBe('no-gh');
  });

  it('reports on-default-branch when branch is main', async () => {
    const { runner } = makeRunner([
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel',
        resp: { code: 0, stdout: '/repo' }
      },
      {
        match: (cmd) => cmd === 'gh',
        resp: { code: 0, stdout: 'gh version 2.0' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref',
        resp: { code: 0, stdout: 'main' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'status',
        resp: { code: 0, stdout: '' }
      }
    ]);
    pr._setRunner(runner);
    const res = await pr.runPreflight('/repo');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === 'on-default-branch')).toBe(true);
    }
  });

  it('reports dirty-tree when working copy has changes', async () => {
    const { runner } = makeRunner([
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel',
        resp: { code: 0, stdout: '/repo' }
      },
      { match: (cmd) => cmd === 'gh', resp: { code: 0, stdout: 'v' } },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref',
        resp: { code: 0, stdout: 'feat/x' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'status',
        resp: { code: 0, stdout: ' M src/foo.ts\n' }
      }
    ]);
    pr._setRunner(runner);
    const res = await pr.runPreflight('/repo');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === 'dirty-tree')).toBe(true);
    }
  });

  it('returns ok with suggested title/body for a healthy feature branch', async () => {
    const { runner } = makeRunner([
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel',
        resp: { code: 0, stdout: '/repo' }
      },
      { match: (cmd) => cmd === 'gh', resp: { code: 0, stdout: 'v' } },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref',
        resp: { code: 0, stdout: 'feat/slash-pr' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'status',
        resp: { code: 0, stdout: '' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'symbolic-ref',
        resp: { code: 0, stdout: 'origin/main' }
      },
      {
        match: (cmd, args) =>
          cmd === 'git' && args[0] === 'for-each-ref',
        resp: { code: 0, stdout: 'main\norigin/main\nfeat/slash-pr\norigin/working\n' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'log' && args[1] === '-1',
        resp: { code: 0, stdout: 'feat(slash): /pr command' }
      },
      {
        match: (cmd, args) =>
          cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify',
        resp: { code: 0, stdout: 'deadbeef' }
      },
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'log' && args[1] === 'origin/main..HEAD',
        resp: { code: 0, stdout: 'feat(slash): /pr command\nchore: add tests\n' }
      }
    ]);
    pr._setRunner(runner);
    const res = await pr.runPreflight('/repo');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.branch).toBe('feat/slash-pr');
      expect(res.base).toBe('main');
      expect(res.suggestedTitle).toBe('feat(slash): /pr command');
      expect(res.suggestedBody).toContain('- feat(slash): /pr command');
      expect(res.suggestedBody).toContain('- chore: add tests');
      expect(res.availableBases).toContain('main');
      expect(res.availableBases).toContain('working');
      expect(res.availableBases).not.toContain('feat/slash-pr');
    }
  });
});

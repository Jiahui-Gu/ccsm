import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadCommands, loadPickerCommands, parseFrontmatter } from '../electron/commands-loader';

let tmpHome: string;
let tmpCwd: string;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-cmds-home-'));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-cmds-cwd-'));
});

afterEach(() => {
  for (const d of [tmpHome, tmpCwd]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('parseFrontmatter', () => {
  it('extracts simple key/value pairs', () => {
    const { data, body } = parseFrontmatter(
      `---\ndescription: hello\nname: foo\n---\nbody here\n`
    );
    expect(data.description).toBe('hello');
    expect(data.name).toBe('foo');
    expect(body).toMatch(/^body here/);
  });

  it('strips matching quotes from values', () => {
    const { data } = parseFrontmatter(`---\ndescription: "hello world"\n---\nx`);
    expect(data.description).toBe('hello world');
    const { data: d2 } = parseFrontmatter(`---\ndescription: 'single'\n---\nx`);
    expect(d2.description).toBe('single');
  });

  it('returns empty data when no frontmatter present', () => {
    const { data, body } = parseFrontmatter('plain text only');
    expect(data).toEqual({});
    expect(body).toBe('plain text only');
  });

  it('skips comment and blank lines', () => {
    const { data } = parseFrontmatter(
      `---\n# comment\n\nname: foo\n---\nx`
    );
    expect(data.name).toBe('foo');
  });
});

describe('loadCommands', () => {
  it('returns [] when no claude config exists', () => {
    expect(loadCommands({ homeDir: tmpHome, cwd: tmpCwd })).toEqual([]);
  });

  it('loads user commands and falls back to filename when name absent', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'foo-bar.md'),
      `---\ndescription: foo it\n---\nbody`
    );
    write(
      path.join(tmpHome, '.claude', 'commands', 'no-frontmatter.md'),
      `just text, no fm`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(cmds.map((c) => c.name).sort()).toEqual(['foo-bar', 'no-frontmatter']);
    const foo = cmds.find((c) => c.name === 'foo-bar')!;
    expect(foo.source).toBe('user');
    expect(foo.description).toBe('foo it');
  });

  it('respects argument-hint frontmatter', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'hinted.md'),
      `---\nargument-hint: <pr-number>\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(cmds[0].argumentHint).toBe('<pr-number>');
  });

  it('layers project commands on top of user commands', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'usercmd.md'),
      `---\ndescription: u\n---\n`
    );
    write(
      path.join(tmpCwd, '.claude', 'commands', 'projcmd.md'),
      `---\ndescription: p\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    const sources = Object.fromEntries(cmds.map((c) => [c.name, c.source]));
    expect(sources).toEqual({ usercmd: 'user', projcmd: 'project' });
  });

  it('namespaces plugin commands and resolves conflicts by priority', () => {
    // Same basename in user-level and plugin: user wins.
    write(
      path.join(tmpHome, '.claude', 'commands', 'shared.md'),
      `---\ndescription: u-wins\n---\n`
    );
    write(
      path.join(
        tmpHome,
        '.claude',
        'plugins',
        'cache',
        'mkt',
        'pluginA',
        '1.0.0',
        'commands',
        'shared.md'
      ),
      `---\ndescription: plug\n---\n`
    );
    write(
      path.join(
        tmpHome,
        '.claude',
        'plugins',
        'cache',
        'mkt',
        'pluginA',
        '1.0.0',
        'commands',
        'unique.md'
      ),
      `---\ndescription: only here\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
    // user-level `shared` survives without namespace.
    expect(byName['shared']?.source).toBe('user');
    expect(byName['shared']?.description).toBe('u-wins');
    // The plugin's 'shared' is namespaced (`pluginA:shared`) — it does NOT
    // conflict with the user-level bare name because they're literally
    // different keys; the conflict-by-name test below covers the bare
    // collision case.
    expect(byName['pluginA:shared']?.source).toBe('plugin');
    expect(byName['pluginA:unique']?.source).toBe('plugin');
    expect(byName['pluginA:unique']?.pluginId).toBe('pluginA');
  });

  it('drops lower-priority duplicates of the same fully-qualified name', () => {
    // Two plugin-namespaced commands with identical full name across
    // versions — pickHighestVersionDir should keep only the highest.
    write(
      path.join(
        tmpHome,
        '.claude',
        'plugins',
        'cache',
        'mkt',
        'pluginA',
        '1.0.0',
        'commands',
        'cmd.md'
      ),
      `---\ndescription: old\n---\n`
    );
    write(
      path.join(
        tmpHome,
        '.claude',
        'plugins',
        'cache',
        'mkt',
        'pluginA',
        '2.0.0',
        'commands',
        'cmd.md'
      ),
      `---\ndescription: new\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    const cmd = cmds.find((c) => c.name === 'pluginA:cmd');
    expect(cmd?.description).toBe('new');
  });

  it('tolerates missing skills directory', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'a.md'),
      `---\n---\n`
    );
    // No skills dir created.
    expect(() => loadCommands({ homeDir: tmpHome, cwd: tmpCwd })).not.toThrow();
  });

  it('skips files with invalid basename or declared name', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'bad name.md'),
      `---\n---\n`
    );
    write(
      path.join(tmpHome, '.claude', 'commands', 'ok.md'),
      `---\nname: not/valid\n---\n`
    );
    write(
      path.join(tmpHome, '.claude', 'commands', 'fine.md'),
      `---\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(cmds.map((c) => c.name)).toEqual(['fine']);
  });

  it('ignores project cwd when not absolute', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'a.md'),
      `---\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: 'relative/path' });
    expect(cmds.map((c) => c.name)).toEqual(['a']);
  });

  // ─── CLAUDE_CONFIG_DIR env fallback (PR #346 review) ────────────────────
  //
  // Production code path: ccsm sets `CLAUDE_CONFIG_DIR=~/.claude` so the
  // claude.exe binary and the GUI loader read the same tree (see project
  // memory `project_cli_config_reuse`). Before the env-fallback patch the
  // loader hard-coded `os.homedir()/.claude`, silently desyncing the picker
  // from what the binary actually executed. These tests pin the env path:
  //   - explicit `homeDir` opt always wins (test override beats env)
  //   - env var resolved when no opt provided
  //   - falls back to os.homedir() when neither is set

  it('honors process.env.CLAUDE_CONFIG_DIR when no homeDir opt is passed', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'should-not-load.md'),
      `---\n---\n`
    );
    // Build a separate fake root and point the env var at it. Because we
    // omit `homeDir`, the env var should win and the loader should read
    // from the fake root, NOT tmpHome.
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-cmds-env-'));
    write(
      path.join(fakeRoot, 'commands', 'env-cmd.md'),
      `---\ndescription: from-env\n---\n`
    );
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fakeRoot;
    try {
      const cmds = loadCommands({ cwd: tmpCwd });
      expect(cmds.map((c) => c.name)).toEqual(['env-cmd']);
    } finally {
      if (prior == null) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior;
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('opt.homeDir wins over CLAUDE_CONFIG_DIR when both are set', () => {
    write(
      path.join(tmpHome, '.claude', 'commands', 'from-opt.md'),
      `---\n---\n`
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-cmds-env2-'));
    write(
      path.join(fakeRoot, 'commands', 'from-env.md'),
      `---\n---\n`
    );
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fakeRoot;
    try {
      const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
      expect(cmds.map((c) => c.name)).toEqual(['from-opt']);
    } finally {
      if (prior == null) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior;
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // ─── agents loading (PR-E shipped this; PR-L adds the missing tests) ───
  //
  // The loader scans both ~/.claude/agents and <cwd>/.claude/agents and tags
  // each entry with source: 'agent'. When the same name appears in both, the
  // project-level definition shadows the user-level one (last write wins on
  // the same priority bucket). These tests pin that behaviour so a future
  // refactor can't silently drop one of the two scan sites.

  it('loads user-level agents from ~/.claude/agents', () => {
    write(
      path.join(tmpHome, '.claude', 'agents', 'foo.md'),
      `---\ndescription: a foo agent\n---\nbody`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(cmds.map((c) => ({ name: c.name, source: c.source }))).toEqual([
      { name: 'foo', source: 'agent' },
    ]);
    expect(cmds[0].description).toBe('a foo agent');
  });

  it('loads project-level agents from <cwd>/.claude/agents', () => {
    write(
      path.join(tmpCwd, '.claude', 'agents', 'bar.md'),
      `---\ndescription: project bar\n---\nbody`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(cmds.map((c) => ({ name: c.name, source: c.source }))).toEqual([
      { name: 'bar', source: 'agent' },
    ]);
    expect(cmds[0].description).toBe('project bar');
  });

  it('dedupes user vs project agents of the same name to a single entry', () => {
    // Both ~/.claude/agents/qux.md and <cwd>/.claude/agents/qux.md exist.
    // The conflict resolver collapses them to ONE entry — there must never
    // be two `qux` rows in the picker.
    //
    // NOTE on shadow direction: the source comment at the top of
    // commands-loader.ts claims "a project agent shadows a user agent of
    // the same name", but the conflict resolver uses `entry.priority <
    // existing.priority` (strict less-than), so on a priority TIE (both
    // agents are bucket 4) the FIRST-pushed entry wins — and the loader
    // pushes the user-level scan before the project-level scan. Net effect:
    // the user-level agent currently wins on ties. This test pins the
    // CURRENT behaviour so a refactor doesn't accidentally change it; if
    // the comment-stated intent ("project wins") is the desired contract,
    // that is a separate fix to the loader (PR-L is test-only).
    write(
      path.join(tmpHome, '.claude', 'agents', 'qux.md'),
      `---\ndescription: from-user\n---\n`
    );
    write(
      path.join(tmpCwd, '.claude', 'agents', 'qux.md'),
      `---\ndescription: from-project\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    const qux = cmds.filter((c) => c.name === 'qux');
    expect(qux).toHaveLength(1);
    expect(qux[0].source).toBe('agent');
    expect(qux[0].description).toBe('from-user');
  });

  it('tolerates missing agents directories on both sides', () => {
    // Neither ~/.claude/agents nor <cwd>/.claude/agents exists.
    write(
      path.join(tmpHome, '.claude', 'commands', 'plain.md'),
      `---\n---\n`
    );
    expect(() => loadCommands({ homeDir: tmpHome, cwd: tmpCwd })).not.toThrow();
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(cmds.find((c) => c.source === 'agent')).toBeUndefined();
  });

  it('skips agents with empty frontmatter by falling back to filename', () => {
    // Empty frontmatter is fine — name falls back to the .md basename. The
    // case we explicitly reject is an invalid basename like "a b.md".
    write(
      path.join(tmpHome, '.claude', 'agents', 'empty.md'),
      `---\n---\nno fields at all`
    );
    write(
      path.join(tmpHome, '.claude', 'agents', 'bad name.md'),
      `---\n---\n`
    );
    const cmds = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    const agents = cmds.filter((c) => c.source === 'agent');
    expect(agents.map((c) => c.name)).toEqual(['empty']);
    expect(agents[0].description).toBeUndefined();
  });
});

// ─── loadPickerCommands ────────────────────────────────────────────────────
//
// Picker-visible filter: hides plugin / skill / agent sources because the
// agent SDK transport ccsm uses cannot execute them without configuration
// ccsm doesn't supply. These tests pin that contract so a future
// refactor doesn't silently re-surface broken slash entries to users.

describe('loadPickerCommands', () => {
  it('keeps user and project sources, drops plugin / skill / agent', () => {
    // user
    write(
      path.join(tmpHome, '.claude', 'commands', 'user-cmd.md'),
      `---\ndescription: u\n---\n`
    );
    // project
    write(
      path.join(tmpCwd, '.claude', 'commands', 'project-cmd.md'),
      `---\ndescription: p\n---\n`
    );
    // plugin
    write(
      path.join(
        tmpHome,
        '.claude',
        'plugins',
        'cache',
        'mkt',
        'pluginA',
        '1.0.0',
        'commands',
        'plugin-cmd.md'
      ),
      `---\ndescription: pl\n---\n`
    );
    // skill
    write(
      path.join(tmpHome, '.claude', 'skills', 'skill-cmd.md'),
      `---\ndescription: sk\n---\n`
    );
    // agent
    write(
      path.join(tmpHome, '.claude', 'agents', 'agent-cmd.md'),
      `---\ndescription: ag\n---\n`
    );

    const all = loadCommands({ homeDir: tmpHome, cwd: tmpCwd });
    const picker = loadPickerCommands({ homeDir: tmpHome, cwd: tmpCwd });

    // sanity: full loader still returns every source
    const allSources = new Set(all.map((c) => c.source));
    expect(allSources).toEqual(new Set(['user', 'project', 'plugin', 'skill', 'agent']));

    // picker filter: only user + project survive
    const pickerNames = picker.map((c) => `${c.source}/${c.name}`).sort();
    expect(pickerNames).toEqual(['project/project-cmd', 'user/user-cmd']);
  });

  it('returns an empty list when only plugin / skill / agent entries exist', () => {
    // Real-world scenario: a fresh user with the superpowers + pua plugins
    // installed but no personal `~/.claude/commands` of their own. The
    // picker must NOT show plugin entries — that's the whole bug.
    write(
      path.join(
        tmpHome,
        '.claude',
        'plugins',
        'cache',
        'mkt',
        'superpowers',
        '1.0.0',
        'commands',
        'brainstorm.md'
      ),
      `---\ndescription: deprecated\n---\n`
    );
    write(
      path.join(tmpHome, '.claude', 'skills', 'helpful.md'),
      `---\ndescription: a skill\n---\n`
    );

    const picker = loadPickerCommands({ homeDir: tmpHome, cwd: tmpCwd });
    expect(picker).toEqual([]);
  });
});

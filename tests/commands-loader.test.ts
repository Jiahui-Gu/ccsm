import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadCommands, parseFrontmatter } from '../electron/commands-loader';

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
});

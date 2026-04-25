import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  filterSlashCommands,
  detectSlashTrigger,
  parseSlashInvocation,
  findSlashCommand,
  groupSlashCommands,
  type SlashCommand,
} from '../src/slash-commands/registry';

function mkDynamic(
  name: string,
  source: 'user' | 'project' | 'plugin' | 'skill' | 'agent',
  description?: string,
  pluginId?: string
): SlashCommand {
  return {
    name,
    description,
    source,
    passThrough: true,
    ...(pluginId ? { pluginId } : {}),
  };
}

describe('filterSlashCommands', () => {
  it('returns the full list for an empty query', () => {
    expect(filterSlashCommands(BUILT_IN_COMMANDS, '')).toEqual(BUILT_IN_COMMANDS);
    expect(filterSlashCommands(BUILT_IN_COMMANDS, '   ')).toEqual(BUILT_IN_COMMANDS);
  });

  it('matches on command name (case-insensitive)', () => {
    const r = filterSlashCommands(BUILT_IN_COMMANDS, 'cl');
    expect(r.some((c) => c.name === 'clear')).toBe(true);
    // 'cl' should NOT match 'compact'
    expect(r.some((c) => c.name === 'compact')).toBe(false);
  });

  it('matches description words too', () => {
    // /clear advertises "context" in its description
    const r = filterSlashCommands(BUILT_IN_COMMANDS, 'context');
    expect(r.some((c) => c.name === 'clear')).toBe(true);
  });

  it('returns empty when nothing matches', () => {
    expect(filterSlashCommands(BUILT_IN_COMMANDS, 'zzzzzqqq')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const snapshot = [...BUILT_IN_COMMANDS];
    filterSlashCommands(BUILT_IN_COMMANDS, 'clear');
    expect(BUILT_IN_COMMANDS).toEqual(snapshot);
  });

  it('places exact name match first', () => {
    const merged = [...BUILT_IN_COMMANDS, mkDynamic('clearance', 'user', 'unrelated')];
    const r = filterSlashCommands(merged, 'clear');
    expect(r[0].name).toBe('clear');
  });
});

describe('detectSlashTrigger', () => {
  it('is inactive for empty input', () => {
    expect(detectSlashTrigger('', 0)).toEqual({ active: false });
  });
  it('is inactive for non-slash input', () => {
    expect(detectSlashTrigger('hello', 3)).toEqual({ active: false });
  });
  it('activates on a bare slash', () => {
    expect(detectSlashTrigger('/', 1)).toEqual({ active: true, query: '' });
  });
  it('extracts the partial command name as query', () => {
    expect(detectSlashTrigger('/cl', 3)).toEqual({ active: true, query: 'cl' });
    expect(detectSlashTrigger('/clear', 6)).toEqual({ active: true, query: 'clear' });
  });
  it('closes once the user types a space', () => {
    expect(detectSlashTrigger('/clear ', 7)).toEqual({ active: false });
    expect(detectSlashTrigger('/clear arg1', 11)).toEqual({ active: false });
  });
  it('does not activate when slash is mid-sentence', () => {
    expect(detectSlashTrigger('hey /help', 9)).toEqual({ active: false });
  });
  it('does not activate when caret is on a later line', () => {
    const v = '/foo\nmore text';
    expect(detectSlashTrigger(v, v.length)).toEqual({ active: false });
  });
  it('activates on first line when caret is still there', () => {
    const v = '/foo\nmore text';
    expect(detectSlashTrigger(v, 3)).toEqual({ active: true, query: 'foo' });
  });
});

describe('findSlashCommand', () => {
  it('finds /clear in built-ins', () => {
    expect(findSlashCommand(BUILT_IN_COMMANDS, 'clear')?.source).toBe('built-in');
  });
  it('returns undefined for unknown', () => {
    expect(findSlashCommand(BUILT_IN_COMMANDS, 'nope')).toBeUndefined();
  });
});

describe('parseSlashInvocation extras', () => {
  it('parses a plugin-namespaced command with args', () => {
    expect(parseSlashInvocation('/superpowers:brainstorm an idea')).toEqual({
      name: 'superpowers:brainstorm',
      args: 'an idea',
    });
  });
});

describe('groupSlashCommands', () => {
  it('groups by source in built-in → user → project → plugin → skill → agent order', () => {
    const merged: SlashCommand[] = [
      ...BUILT_IN_COMMANDS,
      mkDynamic('plug-cmd', 'plugin', 'p', 'sp'),
      mkDynamic('user-cmd', 'user', 'u'),
      mkDynamic('proj-cmd', 'project', 'pj'),
      mkDynamic('skill-cmd', 'skill', 's'),
      mkDynamic('agent-cmd', 'agent', 'a'),
    ];
    const groups = groupSlashCommands(merged);
    expect(groups.map((g) => g.source)).toEqual([
      'built-in',
      'user',
      'project',
      'plugin',
      'skill',
      'agent',
    ]);
    expect(groups[0].commands.map((c) => c.name)).toEqual(['clear', 'compact']);
    expect(groups[1].commands.map((c) => c.name)).toEqual(['user-cmd']);
    expect(groups[2].commands.map((c) => c.name)).toEqual(['proj-cmd']);
    expect(groups[3].commands.map((c) => c.name)).toEqual(['plug-cmd']);
    expect(groups[4].commands.map((c) => c.name)).toEqual(['skill-cmd']);
    expect(groups[5].commands.map((c) => c.name)).toEqual(['agent-cmd']);
  });

  it('omits empty groups', () => {
    const groups = groupSlashCommands(BUILT_IN_COMMANDS);
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('built-in');
  });
});

describe('filterSlashCommands fuzzy matching', () => {
  it('tolerates a single typo in the command name', () => {
    const merged = [
      ...BUILT_IN_COMMANDS,
      mkDynamic('think', 'user', 'extended thinking'),
    ];
    // "thnk" is a one-letter deletion — strict substring matchers reject
    // it, but Fuse should still surface /think.
    const r = filterSlashCommands(merged, 'thnk');
    expect(r.some((c) => c.name === 'think')).toBe(true);
  });

  it('still pins exact-name matches above fuzzier candidates', () => {
    const merged = [
      ...BUILT_IN_COMMANDS,
      mkDynamic('clearance', 'user', 'unrelated'),
      mkDynamic('declare', 'user', 'something with clear inside'),
    ];
    const r = filterSlashCommands(merged, 'clear');
    expect(r[0].name).toBe('clear');
  });
});

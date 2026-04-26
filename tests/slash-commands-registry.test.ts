import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  filterSlashCommands,
  detectSlashTrigger,
  parseSlashInvocation,
  findSlashCommand,
  groupSlashCommands,
  nextSectionIndex,
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
    expect(groups[0].commands.map((c) => c.name)).toEqual(['clear', 'compact', 'config']);
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

describe('nextSectionIndex', () => {
  // Three built-ins (clear, compact, config) — `/think` was retired in
  // favour of the StatusBar Thinking chip — then user, project, plugin
  // sections. Flat layout:
  //   [0] clear           built-in
  //   [1] compact         built-in
  //   [2] config          built-in
  //   [3] u1              user
  //   [4] u2              user
  //   [5] p1              project
  //   [6] pl1             plugin
  //   [7] pl2             plugin
  const fixture: SlashCommand[] = [
    ...BUILT_IN_COMMANDS,
    mkDynamic('u1', 'user'),
    mkDynamic('u2', 'user'),
    mkDynamic('p1', 'project'),
    mkDynamic('pl1', 'plugin'),
    mkDynamic('pl2', 'plugin'),
  ];

  it('Tab from inside built-in jumps to first row of next section (user)', () => {
    expect(nextSectionIndex(fixture, 0, 1)).toBe(3);
    expect(nextSectionIndex(fixture, 1, 1)).toBe(3);
    expect(nextSectionIndex(fixture, 2, 1)).toBe(3);
  });

  it('Tab from inside user jumps to first row of project', () => {
    expect(nextSectionIndex(fixture, 3, 1)).toBe(5);
    expect(nextSectionIndex(fixture, 4, 1)).toBe(5);
  });

  it('Tab from the last section wraps to the first section', () => {
    // Plugin is the last group in fixture; wrap → built-in (idx 0).
    expect(nextSectionIndex(fixture, 6, 1)).toBe(0);
    expect(nextSectionIndex(fixture, 7, 1)).toBe(0);
  });

  it('Shift+Tab from inside a section jumps to the start of the previous section', () => {
    // From plugin → project.
    expect(nextSectionIndex(fixture, 7, -1)).toBe(5);
    // From project → user.
    expect(nextSectionIndex(fixture, 5, -1)).toBe(3);
    // From user → built-in.
    expect(nextSectionIndex(fixture, 3, -1)).toBe(0);
  });

  it('Shift+Tab from the first section wraps to the last section', () => {
    expect(nextSectionIndex(fixture, 0, -1)).toBe(6);
    expect(nextSectionIndex(fixture, 1, -1)).toBe(6);
    expect(nextSectionIndex(fixture, 2, -1)).toBe(6);
  });

  it('skips groups that are empty after filtering', () => {
    // Filter so only built-in (clear) and plugin (pl1) survive — user /
    // project / pl2 are gone. Tab from clear (idx 0) should jump straight
    // to pl1 (idx 1 in the filtered flat list), bypassing the dropped
    // user / project sections entirely.
    const filtered = filterSlashCommands(fixture, 'clear').concat(
      mkDynamic('pl1', 'plugin')
    );
    // Sanity: only built-in + plugin remain after groupSlashCommands drops
    // empty buckets.
    const groups = groupSlashCommands(filtered);
    expect(groups.map((g) => g.source)).toEqual(['built-in', 'plugin']);
    expect(nextSectionIndex(filtered, 0, 1)).toBe(1);
    expect(nextSectionIndex(filtered, 1, 1)).toBe(0);
  });

  it('returns the input index when fewer than two sections are visible', () => {
    const onlyBuiltIn = [...BUILT_IN_COMMANDS];
    expect(nextSectionIndex(onlyBuiltIn, 0, 1)).toBe(0);
    expect(nextSectionIndex(onlyBuiltIn, 1, -1)).toBe(1);
    expect(nextSectionIndex([], 0, 1)).toBe(0);
  });
});

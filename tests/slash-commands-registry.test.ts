import { describe, it, expect } from 'vitest';
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  detectSlashTrigger,
  parseSlashInvocation,
  findSlashCommand
} from '../src/slash-commands/registry';

describe('filterSlashCommands', () => {
  it('returns the full list for an empty query', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, '')).toEqual(SLASH_COMMANDS);
    expect(filterSlashCommands(SLASH_COMMANDS, '   ')).toEqual(SLASH_COMMANDS);
  });

  it('matches on command name (case-insensitive substring)', () => {
    const r = filterSlashCommands(SLASH_COMMANDS, 'cl');
    expect(r.some((c) => c.name === 'clear')).toBe(true);
    // 'cl' should NOT accidentally match 'compact'
    expect(r.some((c) => c.name === 'compact')).toBe(false);
  });

  it('matches on description words too', () => {
    const r = filterSlashCommands(SLASH_COMMANDS, 'token');
    // /cost advertises "token usage" in its description
    expect(r.some((c) => c.name === 'cost')).toBe(true);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, 'zzzzzqqq')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const snapshot = [...SLASH_COMMANDS];
    filterSlashCommands(SLASH_COMMANDS, 'help');
    expect(SLASH_COMMANDS).toEqual(snapshot);
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

  it('closes once the user types a space (now composing args)', () => {
    expect(detectSlashTrigger('/clear ', 7)).toEqual({ active: false });
    expect(detectSlashTrigger('/clear arg1', 11)).toEqual({ active: false });
  });

  it('does not activate when slash is mid-sentence', () => {
    // e.g. "hey /help me" — leading char isn't `/`
    expect(detectSlashTrigger('hey /help', 9)).toEqual({ active: false });
  });

  it('does not activate when caret is on a later line', () => {
    // Value starts with `/`, but the caret is already past the first line →
    // they're writing a multi-line message, not still naming the command.
    const v = '/foo\nmore text';
    const caret = v.length;
    expect(detectSlashTrigger(v, caret)).toEqual({ active: false });
  });

  it('activates when slash is on first line and caret is still on it', () => {
    const v = '/foo\nmore text';
    expect(detectSlashTrigger(v, 3)).toEqual({ active: true, query: 'foo' });
  });
});

describe('/pr registry entry', () => {
  it('is registered as a client command with passThrough false', () => {
    const pr = findSlashCommand('pr');
    expect(pr).toBeDefined();
    expect(pr?.category).toBe('client');
    expect(pr?.passThrough).toBe(false);
  });

  it('parses "/pr" as a bare invocation', () => {
    expect(parseSlashInvocation('/pr')).toEqual({ name: 'pr', args: '' });
  });

  it('captures args after /pr for future extensibility', () => {
    expect(parseSlashInvocation('/pr open draft')).toEqual({
      name: 'pr',
      args: 'open draft'
    });
  });
});

describe('filterSlashCommands ranking', () => {
  it('places exact name match first for /pr', () => {
    const r = filterSlashCommands(SLASH_COMMANDS, 'pr');
    // Anything matching 'pr' could include "PR" in descriptions (e.g. /review).
    // The exact name /pr must come first so activeIndex=0 picks it.
    expect(r[0]?.name).toBe('pr');
  });

  it('prefers prefix over description matches', () => {
    // Adding "co" hits /compact (prefix) and /cost (prefix), but descriptions
    // don't trigger either ahead of them.
    const r = filterSlashCommands(SLASH_COMMANDS, 'com');
    expect(r[0]?.name).toBe('compact');
  });
});

// UT for the pure DnD id helpers in src/components/sidebar/dnd.ts.
//
// These three functions encode the wire-protocol between the DnD context and
// useSidebarDnd's drop dispatcher. A regression here silently breaks
// hover-to-expand on collapsed groups and append-to-empty-group, so they
// deserve table-driven coverage even though each is one line.
import { describe, it, expect } from 'vitest';
import {
  HEADER_PREFIX,
  headerDroppableId,
  parseHeaderDroppable,
} from '../../src/components/sidebar/dnd';

describe('sidebar/dnd id helpers', () => {
  it('exposes the canonical header prefix', () => {
    expect(HEADER_PREFIX).toBe('header:');
  });

  describe('headerDroppableId()', () => {
    it.each([
      ['g1', 'header:g1'],
      ['some-group-uuid', 'header:some-group-uuid'],
      ['', 'header:'],
      ['header:nested', 'header:header:nested'],
    ])('encodes group id %j as %j', (groupId, expected) => {
      expect(headerDroppableId(groupId)).toBe(expected);
    });
  });

  describe('parseHeaderDroppable()', () => {
    it.each([
      ['header:g1', 'g1'],
      ['header:some-group-uuid', 'some-group-uuid'],
      ['header:', ''],
      ['header:header:nested', 'header:nested'],
    ])('extracts the group id from %j → %j', (id, expected) => {
      expect(parseHeaderDroppable(id)).toBe(expected);
    });

    it.each([
      ['plain-session-id'],
      ['Header:g1'], // case sensitive: production uses lowercase prefix only
      [''],
      ['notheader:g1'],
    ])('returns null for non-header id %j', (id) => {
      expect(parseHeaderDroppable(id)).toBeNull();
    });

    it('round-trips with headerDroppableId for arbitrary group ids', () => {
      for (const gid of ['g1', 'A', 'with-dashes', '42']) {
        expect(parseHeaderDroppable(headerDroppableId(gid))).toBe(gid);
      }
    });
  });
});

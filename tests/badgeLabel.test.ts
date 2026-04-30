import { describe, it, expect } from 'vitest';
import { badgeLabel } from '../electron/notify/badgeLabel';

describe('badgeLabel', () => {
  it.each([
    [-1, ''],
    [0, ''],
    [1, '1'],
    [2, '2'],
    [5, '5'],
    [8, '8'],
    [9, '9'],
    [10, '9+'],
    [11, '9+'],
    [99, '9+'],
    [1000, '9+'],
  ])('badgeLabel(%i) === %j', (input, expected) => {
    expect(badgeLabel(input)).toBe(expected);
  });
});

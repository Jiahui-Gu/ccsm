// Static contract tests for the deterministic mobile-remote PTY fixture
// (composer/terminal-sync plan, Task 6). These check the fixture's own
// structural invariants fast, in-process; the real xterm round-trip
// (browser vs. `@xterm/headless` byte-for-byte parity) is proven by
// `scripts/harness-e2e-mobile-terminal-sync.mjs`, which this file does not
// duplicate.

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_ALT_SCREEN_MARKER,
  FIXTURE_CHUNK_COUNT,
  FIXTURE_ERASED_MARKERS,
  FIXTURE_LINE_COUNT,
  FIXTURE_SURVIVING_MARKERS,
  MOBILE_TERMINAL_FIXTURE,
  fixtureLineMarker,
  sequencedFixture,
} from '../../scripts/fixtures/mobile-remote-pty-fixture.mjs';

describe('mobile-remote-pty-fixture', () => {
  it('produces one chunk per array entry with no accidental drift', () => {
    expect(FIXTURE_CHUNK_COUNT).toBe(MOBILE_TERMINAL_FIXTURE.length);
    expect(FIXTURE_CHUNK_COUNT).toBeGreaterThan(FIXTURE_LINE_COUNT);
  });

  it('sequencedFixture assigns a contiguous, gapless seq starting at the given value', () => {
    const sequenced = sequencedFixture(5);
    expect(sequenced).toHaveLength(FIXTURE_CHUNK_COUNT);
    sequenced.forEach((entry, index) => {
      expect(entry.seq).toBe(5 + index);
      expect(entry.chunk).toBe(MOBILE_TERMINAL_FIXTURE[index]);
    });
  });

  it('defaults sequencedFixture() to starting at seq 1', () => {
    expect(sequencedFixture()[0]?.seq).toBe(1);
  });

  it('every numbered line marker is unique and present in exactly one chunk', () => {
    const joined = MOBILE_TERMINAL_FIXTURE.join('');
    for (let n = 1; n <= FIXTURE_LINE_COUNT; n += 1) {
      const marker = fixtureLineMarker(n);
      const count = joined.split(marker).length - 1;
      expect(count, `marker ${marker} must appear exactly once in the raw fixture`).toBe(1);
    }
  });

  it('every FIXTURE_SURVIVING_MARKERS entry is unique across the whole fixture', () => {
    const unique = new Set(FIXTURE_SURVIVING_MARKERS);
    expect(unique.size).toBe(FIXTURE_SURVIVING_MARKERS.length);
    // FIXTURE_AFTER_CLEAR_MARKER + every numbered line + FIXTURE_END_MARKER.
    expect(FIXTURE_SURVIVING_MARKERS.length).toBe(FIXTURE_LINE_COUNT + 2);
  });

  it('erased markers appear strictly before the one clear-screen escape, surviving markers strictly after', () => {
    const joined = MOBILE_TERMINAL_FIXTURE.join('');
    const clearIndex = joined.indexOf('\x1b[2J\x1b[H');
    expect(clearIndex).toBeGreaterThan(-1);
    for (const marker of FIXTURE_ERASED_MARKERS) {
      const markerIndex = joined.indexOf(marker);
      expect(markerIndex, `${marker} must appear before the clear-screen escape`).toBeGreaterThan(-1);
      expect(markerIndex).toBeLessThan(clearIndex);
    }
    for (const marker of FIXTURE_SURVIVING_MARKERS) {
      const markerIndex = joined.indexOf(marker);
      expect(markerIndex, `${marker} must appear after the clear-screen escape`).toBeGreaterThan(clearIndex);
    }
  });

  it('the alternate-screen chunk both enters and exits the alt buffer within one chunk', () => {
    const altChunk = MOBILE_TERMINAL_FIXTURE.find((chunk) => chunk.includes(FIXTURE_ALT_SCREEN_MARKER));
    expect(altChunk).toBeDefined();
    expect(altChunk).toContain('\x1b[?1049h');
    expect(altChunk).toContain('\x1b[?1049l');
    // Marker text sits between enter and exit, so it is written only to the
    // (discarded) alternate screen.
    expect(altChunk!.indexOf('\x1b[?1049h')).toBeLessThan(altChunk!.indexOf(FIXTURE_ALT_SCREEN_MARKER));
    expect(altChunk!.indexOf(FIXTURE_ALT_SCREEN_MARKER)).toBeLessThan(altChunk!.lastIndexOf('\x1b[?1049l'));
  });

  it('carries a CR-overwrite progress sequence (0% -> 50% -> done) ahead of the clear', () => {
    const joined = MOBILE_TERMINAL_FIXTURE.slice(0, MOBILE_TERMINAL_FIXTURE.indexOf(
      MOBILE_TERMINAL_FIXTURE.find((chunk) => chunk.includes('\x1b[2J\x1b[H'))!,
    )).join('');
    expect(joined).toContain('progress 0%');
    expect(joined).toContain('\r\x1b[2Kprogress 50%');
    expect(joined).toMatch(/\r\x1b\[2K.*PROGRESS-100/);
  });
});

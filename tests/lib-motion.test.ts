// UT for src/lib/motion.ts — motion token kit. These are mostly constants,
// so most of this file tests *invariants* (ordering, shape, cross-token
// consistency, alias identity) rather than mirroring exact literal values.
// A literal mirror (e.g. `expect(DURATION.standard).toBeCloseTo(0.18)`)
// normally fails in lockstep with any intentional token tweak and asserts
// nothing beyond "the constant is still the constant" — see
// docs/reference/testing-strategy.md on avoiding change-detector tests.
//
// EXCEPTION: `EASING.standard`/`enter`/`exit` and `DURATION.fast`/`standard`
// are genuine shared cross-runtime contracts, not isolated constants. The
// exact same values are hand-duplicated as CSS custom properties/literals
// (`src/styles/global.css` `--ease-spring: cubic-bezier(0.32, 0.72, 0, 1)`,
// `transition: opacity 180ms ...`) and as Tailwind arbitrary-value classes
// / inline framer-motion props across 10+ components (e.g. `FileTree.tsx`'s
// `ease: [0, 0, 0.2, 1]`, `ContextMenu.tsx`/`Tooltip.tsx`'s
// `animate-[...140ms...]`, `SessionRow.tsx`'s `duration-[180ms]`) that don't
// import from this module. `motion.ts`'s own doc comments assert these
// values "match existing inline" usage. A pure shape/ordering invariant
// would let a typo in one of these (e.g. `0.72` -> `0.27`, or `0.14` ->
// `0.15`) pass here while silently diverging from every CSS/Tailwind copy —
// so this specific subset of values is pinned explicitly, on purpose, as a
// cross-runtime consistency guard, not a change-detector test.
import { describe, it, expect } from 'vitest';
import {
  DURATION,
  DURATION_RAW,
  EASING,
  MOTION_PRESETS,
  MOTION_SESSION_SWITCH_DURATION,
  MOTION_STANDARD_EASING,
} from '../src/lib/motion';

describe('motion tokens', () => {
  describe('DURATION', () => {
    it('exposes the canonical 5-tier scale, strictly increasing and unique', () => {
      const tiers = ['instant', 'fast', 'standard', 'slow', 'deliberate'] as const;
      const ordered = tiers.map((k) => DURATION[k]);
      const sorted = [...ordered].sort((a, b) => a - b);
      expect(ordered).toEqual(sorted);
      expect(new Set(ordered).size).toBe(ordered.length);
      for (const n of ordered) {
        expect(typeof n).toBe('number');
        expect(n).toBeGreaterThan(0);
      }
    });

    // Cross-runtime contract guard (see file header): `fast` (140ms) and
    // `standard` (180ms) are hand-duplicated as Tailwind arbitrary-value
    // literals and CSS `transition:` rules elsewhere in the renderer (e.g.
    // `ContextMenu.tsx`/`Tooltip.tsx`'s `animate-[...140ms...]`,
    // `SessionRow.tsx`'s `duration-[180ms]`, `global.css`'s
    // `transition: opacity 180ms ...`). The ordering/uniqueness invariant
    // above would let either value drift by typo without catching the
    // resulting mismatch against those copies.
    it('fast/standard match the canonical durations duplicated in CSS + Tailwind usage', () => {
      expect(DURATION.fast).toBeCloseTo(0.14);
      expect(DURATION.standard).toBeCloseTo(0.18);
    });
  });

  describe('DURATION_RAW', () => {
    it('each ms-named key converts its embedded millisecond count to seconds', () => {
      for (const [key, value] of Object.entries(DURATION_RAW)) {
        const ms = Number(key.replace('ms', ''));
        expect(ms).toBeGreaterThan(0);
        expect(value).toBeCloseTo(ms / 1000);
      }
    });
  });

  describe('EASING', () => {
    it('standard / enter / exit are 4-tuples (cubic-bezier control points)', () => {
      for (const key of ['standard', 'enter', 'exit'] as const) {
        const t = EASING[key];
        expect(Array.isArray(t)).toBe(true);
        expect(t).toHaveLength(4);
        for (const n of t) expect(typeof n).toBe('number');
      }
    });

    it('linear is the literal "linear" string for framer-motion', () => {
      expect(EASING.linear).toBe('linear');
    });

    it('enter and exit are distinct curves (soft-in vs firm-out are not the same shape)', () => {
      expect(EASING.enter).not.toEqual(EASING.exit);
    });

    // Cross-runtime contract guard (see file header): these three curves
    // are hand-duplicated as CSS custom properties/inline literals and as
    // inline framer-motion `ease` props elsewhere in the renderer. Pin the
    // exact values so a typo here is caught instead of silently forking
    // from every other copy.
    it('standard/enter/exit match the canonical curves duplicated in CSS + inline framer-motion usage', () => {
      expect(EASING.standard).toEqual([0.32, 0.72, 0, 1]);
      expect(EASING.enter).toEqual([0, 0, 0.2, 1]);
      expect(EASING.exit).toEqual([0.7, 0, 0.84, 0]);
    });
  });

  describe('MOTION_PRESETS', () => {
    it.each(['fadeIn', 'fadeOut', 'sessionSwitch', 'selectionRing', 'paneEnter', 'disclosure', 'bannerIn'] as const)(
      '%s preset has a transition object with a positive duration + valid ease token',
      (key) => {
        const preset = MOTION_PRESETS[key];
        expect(preset).toBeDefined();
        const tx = (preset as { transition: { duration: number; ease: unknown } }).transition;
        expect(typeof tx.duration).toBe('number');
        expect(tx.duration).toBeGreaterThan(0);
        // `ease` must be one of the exported EASING values (or the literal
        // 'linear' string) — not an ad-hoc inline curve.
        const knownEases = Object.values(EASING);
        expect(knownEases).toContainEqual(tx.ease);
      }
    );

    it('fadeIn / fadeOut carry opposite opacity directions', () => {
      expect(MOTION_PRESETS.fadeIn.opacity).toEqual([0, 1]);
      expect(MOTION_PRESETS.fadeOut.opacity).toEqual([1, 0]);
    });
  });

  describe('compatibility aliases (#192)', () => {
    it('MOTION_SESSION_SWITCH_DURATION mirrors DURATION.standard by reference', () => {
      expect(MOTION_SESSION_SWITCH_DURATION).toBe(DURATION.standard);
    });

    it('MOTION_STANDARD_EASING mirrors EASING.standard by reference', () => {
      expect(MOTION_STANDARD_EASING).toBe(EASING.standard);
    });
  });
});

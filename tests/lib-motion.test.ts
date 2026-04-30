// UT for src/lib/motion.ts — motion token kit. These are constants, but
// the module is the single source of truth for animation timing/easing
// across the renderer; pinning shape + key values catches accidental
// breakage of components that consume the tokens via `DURATION.standard`,
// `EASING.enter`, `MOTION_PRESETS.fadeIn`, etc.
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
    it('exposes the canonical 5-tier scale in seconds', () => {
      expect(DURATION.instant).toBeCloseTo(0.08);
      expect(DURATION.fast).toBeCloseTo(0.14);
      expect(DURATION.standard).toBeCloseTo(0.18);
      expect(DURATION.slow).toBeCloseTo(0.24);
      expect(DURATION.deliberate).toBeCloseTo(0.32);
    });

    it('values are strictly increasing across tiers', () => {
      const ordered = [
        DURATION.instant,
        DURATION.fast,
        DURATION.standard,
        DURATION.slow,
        DURATION.deliberate,
      ];
      const sorted = [...ordered].sort((a, b) => a - b);
      expect(ordered).toEqual(sorted);
      expect(new Set(ordered).size).toBe(ordered.length);
    });
  });

  describe('DURATION_RAW', () => {
    it('exposes the legacy ms-named values used during migration', () => {
      expect(DURATION_RAW.ms150).toBeCloseTo(0.15);
      expect(DURATION_RAW.ms200).toBeCloseTo(0.2);
      expect(DURATION_RAW.ms220).toBeCloseTo(0.22);
      expect(DURATION_RAW.ms250).toBeCloseTo(0.25);
      expect(DURATION_RAW.ms300).toBeCloseTo(0.3);
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

    it('standard matches the legacy [0.32,0.72,0,1] curve', () => {
      expect(EASING.standard).toEqual([0.32, 0.72, 0, 1]);
    });

    it('exit is the mirror of enter (symmetric acceleration)', () => {
      expect(EASING.enter).toEqual([0, 0, 0.2, 1]);
      expect(EASING.exit).toEqual([0.7, 0, 0.84, 0]);
    });
  });

  describe('MOTION_PRESETS', () => {
    it.each(['fadeIn', 'fadeOut', 'sessionSwitch', 'selectionRing', 'paneEnter', 'disclosure', 'bannerIn'] as const)(
      '%s preset has a transition object with duration + ease',
      (key) => {
        const preset = MOTION_PRESETS[key];
        expect(preset).toBeDefined();
        const tx = (preset as { transition: { duration: number; ease: unknown } }).transition;
        expect(typeof tx.duration).toBe('number');
        expect(tx.ease).toBeDefined();
      }
    );

    it('fadeIn / fadeOut carry the opacity keyframes they document', () => {
      expect(MOTION_PRESETS.fadeIn.opacity).toEqual([0, 1]);
      expect(MOTION_PRESETS.fadeOut.opacity).toEqual([1, 0]);
    });
  });

  describe('compatibility aliases (#192)', () => {
    it('MOTION_SESSION_SWITCH_DURATION mirrors DURATION.standard', () => {
      expect(MOTION_SESSION_SWITCH_DURATION).toBe(DURATION.standard);
    });

    it('MOTION_STANDARD_EASING mirrors EASING.standard', () => {
      expect(MOTION_STANDARD_EASING).toBe(EASING.standard);
    });
  });
});

/**
 * Unified motion token kit.
 *
 * One source of truth for animation durations, easing curves, and common
 * framer-motion `transition` presets. Inline `duration: 0.22, ease: [...]`
 * literals should consume these tokens instead of hard-coding numbers, so
 * the motion language stays consistent as the app grows.
 *
 * Design:
 * - 5 duration tiers covering micro-feedback → layout shifts.
 * - 3 easing curves covering steady (codebase default), soft enter
 *   (deceleration), and firm exit (acceleration), plus `linear`.
 * - Presets are ready-to-spread objects for `<motion.* animate={...} />`.
 *
 * Reduced motion: the global stylesheet already shortens/neutralises
 * transitions and animations via `@media (prefers-reduced-motion: reduce)`
 * in `src/styles/global.css`. Components that want to opt framer-motion out
 * explicitly can import `useReducedMotion` from `framer-motion` directly —
 * no extra helper is added here to avoid a parallel system.
 */

/**
 * Cubic-bezier control points. Keep as a tuple for framer-motion's
 * `ease` prop (which rejects plain `number[]`).
 */
export type EasingTuple = readonly [number, number, number, number];

/**
 * Duration tokens, in seconds (framer-motion units).
 *
 * | Token       | ms  | Use                                        |
 * | ----------- | --- | ------------------------------------------ |
 * | instant     |  80 | micro-feedback (button press, icon swap)   |
 * | fast        | 140 | hover transitions, small crossfades        |
 * | standard    | 180 | default (session switch, dialog fade)      |
 * | slow        | 240 | pane entrance, heavy content, rails        |
 * | deliberate  | 320 | long-list re-order, layout shifts          |
 */
export const DURATION = {
  instant: 0.08,
  fast: 0.14,
  standard: 0.18,
  slow: 0.24,
  deliberate: 0.32,
} as const;

export type DurationToken = keyof typeof DURATION;

/**
 * Granular durations for migrating legacy inline values without shifting
 * perceived motion. Prefer the semantic `DURATION.*` tokens for NEW code;
 * use these only when the exact millisecond count is load-bearing (e.g.
 * a carefully-tuned settle).
 *
 * Units: seconds, same as `DURATION`.
 */
export const DURATION_RAW = {
  ms150: 0.15,
  ms200: 0.2,
  ms220: 0.22,
  ms250: 0.25,
  ms300: 0.3,
} as const;

/**
 * Easing tokens.
 *
 * - `standard` — matches existing inline `[0.32, 0.72, 0, 1]` (codebase
 *   default, feels "crisp settle"). Use for generic enter/exit on
 *   non-directional elements.
 * - `enter` — soft deceleration; matches existing `[0, 0, 0.2, 1]`. Use
 *   when something slides/fades IN from invisibility.
 * - `exit` — firm acceleration; mirror of `enter`. Use when something
 *   slides/fades OUT (often paired with `DURATION.instant|fast`).
 * - `linear` — literal `'linear'` string (framer-motion accepts it).
 */
export const EASING = {
  standard: [0.32, 0.72, 0, 1] as EasingTuple,
  enter: [0, 0, 0.2, 1] as EasingTuple,
  exit: [0.7, 0, 0.84, 0] as EasingTuple,
  linear: 'linear' as const,
} as const;

export type EasingToken = keyof typeof EASING;

/**
 * Ready-to-spread framer-motion `transition` objects and common animation
 * presets. Each preset's `transition` field is a new object so callers can
 * override without mutating the shared instance.
 */
export const MOTION_PRESETS = {
  /** opacity 0 → 1, fast + soft enter. */
  fadeIn: {
    opacity: [0, 1] as [number, number],
    transition: { duration: DURATION.fast, ease: EASING.enter },
  },
  /** opacity 1 → 0, instant + firm exit. Leaves the stage fast. */
  fadeOut: {
    opacity: [1, 0] as [number, number],
    transition: { duration: DURATION.instant, ease: EASING.exit },
  },
  /** Session-pane / dialog switch: standard duration, standard ease. */
  sessionSwitch: {
    transition: { duration: DURATION.standard, ease: EASING.standard },
  },
  /** Focus / selection ring slide-in on list rows. */
  selectionRing: {
    transition: { duration: DURATION.slow, ease: EASING.standard },
  },
  /** Full-pane entrance (sidebar resize, settings tab swap). */
  paneEnter: {
    transition: { duration: DURATION.slow, ease: EASING.standard },
  },
  /** Chevron rotate / disclosure. */
  disclosure: {
    transition: { duration: DURATION.standard, ease: EASING.enter },
  },
  /** Banner / toast slide-and-fade in. */
  bannerIn: {
    transition: { duration: DURATION.fast, ease: EASING.enter },
  },
} as const;

export type MotionPreset = keyof typeof MOTION_PRESETS;

// ---------------------------------------------------------------------------
// Compatibility aliases for task #192 (cross-pane motion). These let the
// parallel branch land either order without duplicating constants.
// ---------------------------------------------------------------------------

/** Standard-duration session / pane switch. Alias of `DURATION.standard`. */
export const MOTION_SESSION_SWITCH_DURATION = DURATION.standard;

/** Codebase-default easing curve. Alias of `EASING.standard`. */
export const MOTION_STANDARD_EASING = EASING.standard;

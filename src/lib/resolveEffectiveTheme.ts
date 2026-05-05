// Pure projection: (systemPref, userOverride) -> effective theme.
//
// Spec: docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-design.md §2 (theme),
// §5.3.7 PR-7. Spec requires a tri-state `systemPref` ('light' | 'dark' |
// 'no-preference') so that the renderer can faithfully project the OS
// preferred-color-scheme media query (`light`, `dark`, or
// `not all` / `no-preference`) through the user's own override
// ('light' | 'dark' | 'system'). 6 combos total; default for the
// `no-preference` + `system` cell is `light` to match the existing
// `resolveEffectiveTheme(theme, osPrefersDark: false)` behaviour in
// `src/stores/slices/appearanceSlice.ts`.
//
// Kept distinct from the existing boolean-arg helper in
// `appearanceSlice.ts` (which `useThemeEffect` previously called) because
// changing that signature would ripple through `CommandPalette` and other
// call sites. The boolean helper remains; this lib is the new, tri-state
// projection that the theme effect now consumes.

export type SystemPref = 'light' | 'dark' | 'no-preference';
export type UserOverride = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';

/**
 * Project the OS-level color-scheme signal through the user's override
 * setting.
 *
 * - Explicit override (`'light'` / `'dark'`) always wins, regardless of
 *   the OS signal — this is what "user override" means.
 * - When the user picks `'system'` we follow the OS:
 *   - `'dark'`          -> `'dark'`
 *   - `'light'`         -> `'light'`
 *   - `'no-preference'` -> `'light'` (sensible default; matches the
 *     legacy `osPrefersDark=false` behaviour and Apple/GNOME defaults).
 */
export function resolveEffectiveTheme(
  systemPref: SystemPref,
  userOverride: UserOverride
): EffectiveTheme {
  if (userOverride === 'light') return 'light';
  if (userOverride === 'dark') return 'dark';
  // userOverride === 'system' — follow OS
  if (systemPref === 'dark') return 'dark';
  return 'light';
}

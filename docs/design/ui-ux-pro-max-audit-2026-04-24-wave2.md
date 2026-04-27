# UI/UX Pro Max Audit — Wave 2 (2026-04-24)

Second-pass full-app sweep with fresh eyes. Wave 1 closed 27 P0/P1 items
(focus-ring U2/#240, ImportDialog #243, ConfirmDialog i18n #257, banner trio
unification #207/#237, dropped-tool contrast #242, InputBar typography #241,
text-display tier #256, CommandPalette no-matches #258, sidebar resizer #259,
CliMissingDialog tabs/links #260, banner role-per-variant #261, U3 token
cleanup #255, etc.). Wave 2 looks for what wave 1 missed and any regressions
introduced by those merges.

Surfaces audited in this pass:

- AssistantBlock prose + CodeBlock (no copy button)
- Three top banners (post #207 unification — i18n + DRY check)
- PermissionPromptBlock (post #214 Allow-always)
- Tutorial steps 2+ + visuals
- ShortcutOverlay (#188)
- SettingsDialog Appearance + Notifications + Connection + Updates panes
- ImportDialog (post #243)
- CommandPalette (post #258)
- ConfirmDialog / Toast / Button / IconButton primitives
- ChatStream EmptyState + jump-to-latest
- StatusBar chips + popovers
- System tray menu (electron/main.ts)
- Locale files (zh + en) for Agentory→ccsm bleed and SCREAMING strings
- QuestionBlock (post #240 focus-ring-waiting / -success)
- InputBar trailing controls

> **Screenshots note.** A clean dist/web build was not available at audit
> time and producing one would have eaten the time budget without changing
> any of the findings (every issue below is observable from source).
> `dogfood-logs/ux-promax-wave2/` holds the deferred-capture README; before
> fixing visual P0/P1 items the implementer should capture before/after
> there per the project's
> `feedback_visual_fix_screenshots` rule.

Priority key:
- **P0** — visible/broken (regression, i18n leak, missing focus-ring on
  reachable element, accessibility role wrong)
- **P1** — polish or a11y (inconsistency, token-bypass, semantic miss,
  duplicate styling)
- **P2** — nice-to-have

---

## P0 findings

### W2-01 · Banner trio inlined English copy after #207 unification (i18n regression)
- **Surface:** `src/components/AgentInitFailedBanner.tsx:65,83,96`,
  `src/components/AgentDiagnosticBanner.tsx:43,46`
- **Description:** When the three top banners were folded onto the shared
  `<TopBanner />` in #207, two of the three callers (`AgentInitFailedBanner`,
  `AgentDiagnosticBanner`) hard-coded their copy: `title="Failed to start
  Claude"`, `"Retrying…"`, `"Retry"`, `"Reconfigure"`,
  `dismissLabel="Dismiss diagnostic"`, `title="Agent error" / "Agent warning"`.
  ClaudeCliMissingBanner uses `t(...)` correctly, so this is a regression
  in the unification PR, not a pre-existing gap. Chinese users see English
  on every CLI failure path.
- **Suggested fix:** Add `cli.initFailedTitle` / `agentInit.retry` /
  `agentInit.reconfigure` / `diagnostic.errorTitle` etc. to en.ts + zh.ts
  and route both banners through `useTranslation()`.

### W2-02 · TopBanner action buttons duplicated 3× with hard-coded shadow color
- **Surface:** `src/components/AgentInitFailedBanner.tsx:75-93`,
  `src/components/ClaudeCliMissingBanner.tsx:36-40`,
  `src/components/chrome/TopBanner.tsx:155-159`
- **Description:** Each banner re-implements an identical "dark transparent
  button on a colored banner" style with the literal string
  `focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]`. The dismiss button
  inside TopBanner uses the same magic value. Three call-sites + one
  internal = four places, none of which routes through a token. Any future
  change to focus-ring color on banners requires hunting four files.
- **Suggested fix:** Extract a `<TopBannerAction />` (or `bannerActionVariants`
  cva) inside `chrome/TopBanner.tsx` exposing `variant: 'primary' | 'secondary'`,
  and replace the four inline implementations.

### W2-03 · `infoLabel` / `warnLabel` locale strings shipped in SCREAMING
- **Surface:** `src/i18n/locales/en.ts:65-66` (`'INFO'`, `'WARN'`); rendered
  by `src/components/chat/blocks/StatusBanner.tsx:25` which already applies
  `uppercase` via Tailwind.
- **Description:** Violates `feedback_no_uppercase_ui_strings`. The
  `uppercase` Tailwind class on the consumer means the string is
  double-uppercased visually but the source string is what shows up in
  translation tools, screen-reader history, and zh fallback. zh.ts already
  uses `'信息'`/`'警告'` (correct), so en.ts is the outlier.
- **Suggested fix:** Change to `'Info'` / `'Warn'` (sentence case). The
  `uppercase` class on the consumer takes care of presentation; locale
  string stays human-readable.

### W2-04 · System tray context menu strings hard-coded English (no i18n)
- **Surface:** `electron/main.ts:393,409,412`
- **Description:** Tray tooltip is `'CCSM'` and the context menu has
  `'Show CCSM'` and `'Quit'` as hard-coded English literals. Chinese users
  who minimize-to-tray see English. Tray sits outside the React tree so it
  doesn't have access to `useTranslation()`, but the existing `electron/i18n.ts`
  module is built precisely for this case (it's already used for OS
  notifications).
- **Suggested fix:** Wire the three labels through `electron/i18n.ts` and
  rebuild the context menu when the user changes language (the i18n module
  already broadcasts a change event).

### W2-05 · CodeBlock has no copy button — friction for the most common chat action
- **Surface:** `src/components/CodeBlock.tsx:46-67`
- **Description:** The component renders a Prism-highlighted block but has no
  affordance to copy the code. Users hand-select with the mouse, dragging
  past line numbers and triggering selection-collapse on a re-render mid-stream.
  Both Claude Code CLI and Claude Desktop ship a hover copy button on every
  fenced block; this is the single most-requested action in the assistant
  body. Affects every assistant turn that includes code.
- **Suggested fix:** Wrap `<Highlight>` in a `<div className="group relative">`
  and add a top-right `<IconButton>` with `<Copy>` icon that becomes visible on
  group-hover, with a transient "Copied" tooltip via the existing Tooltip
  primitive. Add `chat.copyCode` / `chat.copied` locale strings.

### W2-06 · ImportDialog per-row checkboxes still raw `<input type="checkbox">`
- **Surface:** `src/components/ImportDialog.tsx:193-199`
- **Description:** PR #243 (audit ID2/ID3) replaced the bulk-select checkbox
  with a Radix Checkbox.Root carrying brand-cyan + focus-ring, but the
  per-row checkboxes inside each bucket are still native `<input>` with only
  `accent-accent` (no focus-ring, no consistent visual weight, smaller hit
  area than 16×16, doesn't match SettingsDialog's CrashReportingField which
  uses Checkbox.Root). Tabbing through the list shows the OS native focus
  outline, not the brand ring. Inconsistency the user feels immediately
  when comparing rows to the bulk action.
- **Suggested fix:** Promote the per-row checkbox to Radix `Checkbox.Root`
  with the same class string used by `CrashReportingField` in
  `SettingsDialog.tsx:550-561`, and let the `<li onClick>` toggle continue
  for click-row-to-toggle convenience.

### W2-07 · NotificationsPane + UpdatesPane toggles are raw `<input type="checkbox">`
- **Surface:** `src/components/SettingsDialog.tsx:419-426` (`Toggle` inside
  NotificationsPane), `src/components/SettingsDialog.tsx:625-632` (autoCheck)
- **Description:** Five toggles in NotificationsPane (enable / permission /
  question / turnDone / sound) and the auto-check-updates toggle are native
  checkboxes with `accent-accent` and no focus-ring. CrashReportingField in
  the same file (line 546) uses Radix Checkbox.Root with focus-visible ring.
  Inside the same dialog, three different toggle visual treatments (Radix
  checkbox, native checkbox, segmented radio) ship side-by-side. Keyboard
  users tabbing through Settings see the OS-native focus rectangle on six
  controls and the brand ring on one.
- **Suggested fix:** Either standardize on Radix Checkbox (matches
  CrashReportingField) or — better, since these are on/off prefs —
  introduce a small `<Switch>` primitive (Radix `Switch.Root`) and use it
  for all six. Either way the visual treatment + focus ring must be
  consistent across the entire dialog.

### W2-08 · AssistantBlock h2 and h3 render visually identical
- **Surface:** `src/components/chat/blocks/AssistantBlock.tsx:50-51`
- **Description:** Post-#256 added the `text-display` (21px) tier and h1
  uses it, but h2 and h3 both use `text-heading` and both `font-semibold`;
  the only difference is `mb-1.5` vs `mb-1`. In a long assistant response
  with `## Section` and `### Subsection`, the user cannot visually
  distinguish the two levels. Violates the type-ladder integrity goal of
  this wave.
- **Suggested fix:** Either drop h3 to `text-body` + `font-semibold` (or
  `text-chrome` + `font-semibold`), or introduce a `text-subheading` tier
  in `styles/global.css` and use it for h3. Recommended: h3 → `text-body
  font-semibold`, since an h3 inside chat prose is already rare.

### W2-09 · TopBanner body line uses raw `text-[11px]` instead of `text-meta` token
- **Surface:** `src/components/chrome/TopBanner.tsx:136`
- **Description:** Wave U3 (#255) explicitly migrated `text-meta` everywhere
  it was a raw px value. The TopBanner body line introduced in #207 slipped
  through with `text-[11px]`. Same value as `text-meta` (11px), but bypasses
  the token system and breaks the "no raw text-px" rule that U3 established.
- **Suggested fix:** Replace `'text-[11px] truncate opacity-90'` with
  `'text-meta truncate opacity-90'`.

---

## P1 findings

### W2-10 · Toast `error` kind reuses waiting StateGlyph (clock) tinted red
- **Surface:** `src/components/ui/Toast.tsx:107-109`
- **Description:** The error toast renders `<StateGlyph state="waiting" …
  text-state-error />` — i.e. the clock/hourglass glyph painted red. A red
  clock means "running and stuck", not "error". Users will misread this as a
  long-running operation, not as a failure. lucide-react already ships
  `AlertCircle` / `XCircle` which are universally read as error.
- **Suggested fix:** Add an `error` case to StateGlyph (or render
  `<AlertCircle>` directly here) so the error toast carries an error-shaped
  glyph, not a clock.

### W2-11 · Toast missing `aria-live`; click-to-dismiss eats error toasts
- **Surface:** `src/components/ui/Toast.tsx:73-101`
- **Description:** The toast container has `role="status"` per-toast but no
  `aria-live` on the wrapper, so screen readers may not announce new
  toasts depending on their announcement strategy. Also the entire toast
  body is the click-to-dismiss target (line 95-100), with the only
  exception being persistent-with-action toasts. An error toast can be
  dismissed by a stray click before the user finishes reading it.
- **Suggested fix:** Add `aria-live="polite" aria-atomic="false"` to the
  wrapper `<div>` at line 76. Restrict click-to-dismiss to a dedicated
  close button (or only on `info` kind) and let `error`/`waiting` rely on
  the auto-timer + explicit close.

### W2-12 · QuestionBlock `Submit` button has no focus-ring matching the waiting halo
- **Surface:** `src/components/QuestionBlock.tsx:137-145`
- **Description:** #240 added `focus-ring-waiting` and `focus-ring-success`
  utilities and migrated the option labels and inner radio/checkbox to use
  them. The Submit `<Button variant="primary">` at the bottom of the
  prompt still uses Button's default focus shadow (cyan accent), which
  visually clashes with the amber-themed waiting context — keyboard users
  see the panel halo amber and the button halo cyan side by side.
- **Suggested fix:** Pass `className="focus-ring-waiting"` (or after submit,
  `focus-ring-success`) to the Submit Button so all interactive elements
  inside the waiting card share one halo color.

### W2-13 · ChatStream "Jump to latest" button has no focus-ring
- **Surface:** `src/components/ChatStream.tsx:222-234`
- **Description:** The floating jump-to-latest button is keyboard-reachable
  (it's a real `<motion.button>`) but its className has no `focus-ring`,
  no `focus-visible:`, no outline. Tab cycle lands on it invisibly.
- **Suggested fix:** Add `outline-none focus-ring` to the className list
  (the rest of the styling already permits a halo since it's
  `position: absolute`).

### W2-14 · Tutorial step dots use raw OKLCH for state colors instead of token
- **Surface:** `src/components/Tutorial.tsx:181`
- **Description:** `dotColor` returns `bg-[oklch(0.78_0.16_145)]` /
  `bg-[oklch(0.78_0.16_70)]` literals for running/waiting state. Real app
  uses `state-running` / `state-waiting` tokens. If tokens shift (e.g. theme
  refresh), the tutorial drifts and shows colors that don't match the live
  sidebar — exactly when the user is comparing the two.
- **Suggested fix:** Use `bg-state-running` / `bg-state-waiting` so the
  tutorial visual stays in sync with the live sidebar.

### W2-15 · Tutorial WelcomeVisual gradient uses raw OKLCH not brand token
- **Surface:** `src/components/Tutorial.tsx:165`
- **Description:** Hard-coded `from-[oklch(0.72_0.14_215)] to-[oklch(0.55_0.18_265)]`
  instead of using the brand cyan token (`var(--color-accent)`). Same tile
  appears on the welcome screen — it's the user's first impression of the
  app's color identity. If brand color shifts, this tile is the one place
  that won't follow.
- **Suggested fix:** Replace with a token-driven gradient using
  `var(--color-accent)` and a derived secondary stop.

### W2-16 · ShortcutOverlay h3 + kbd use raw `text-[11px]` not `text-meta`
- **Surface:** `src/components/ShortcutOverlay.tsx:80,141`
- **Description:** Same U3 violation as TopBanner — two more raw `text-[11px]`
  literals in a file that was created post-#225 (token migration).
  text-meta = 11px so the visual is identical, but the rule was "no raw
  px in text classes".
- **Suggested fix:** Replace both occurrences with `text-meta`.

### W2-17 · Sentence "shortcuts.groupNavigation" rows include `?` as a binding alongside `Cmd+/`
- **Surface:** `src/components/ShortcutOverlay.tsx:55`
- **Description:** The "Open this overlay" row renders `?  ·  ⌘ + /` —
  the bare `?` as a key chip is not a registered shortcut except by
  ambient `keydown` capture in App.tsx; it doesn't fire if focus is in the
  composer (because `?` is a printable char). Documenting it here implies
  it works everywhere; users will press `?` while typing and get nothing.
- **Suggested fix:** Either (a) drop the `?` chip and only document
  `⌘+/`, or (b) wire `?` to fire only when `document.activeElement` is not
  a text-entry — and keep documenting it.

### W2-18 · CommandPalette palette body has no enter motion (only fades on container)
- **Surface:** `src/components/CommandPalette.tsx:198-204`
- **Description:** The container animates in via `data-[state=open]:animate-[dialogIn_…]`
  but the result rows don't have any enter motion. Compared to ChatStream
  blocks (each animates with framer-motion) and SlashCommandPicker (which
  animates per row), the palette feels "pop, here's a static list". Apple
  HIG Spotlight stagger-fades each row on enter; this is the area where the
  app most directly competes with native search.
- **Suggested fix:** Wrap each `<li>` in `<motion.li>` with a
  `delay: i * 0.015, duration: 0.18` enter; cap stagger at 8 rows so a
  long list doesn't feel sluggish.

### W2-19 · Settings tab indicator uses `bg-accent` but the active row uses `bg-bg-hover`
- **Surface:** `src/components/SettingsDialog.tsx:140-149,150-156`
- **Description:** Active tab background is `bg-bg-hover` (neutral), but
  the 3px left rail is `bg-accent` (cyan). Two visual cues for the same
  thing in two different families. Either commit to the rail being the
  cue and drop the background change (cleaner, like macOS Settings), or
  commit to the background being the cue and drop the rail (matches
  GitHub-style sidebars). Currently both compete for the eye.
- **Suggested fix:** Drop `bg-bg-hover text-fg-primary font-medium` from
  the active branch and lean on the rail + bumped color to indicate
  selection. macOS Settings is the model.

### W2-20 · `_Select` is dead code in SettingsDialog
- **Surface:** `src/components/SettingsDialog.tsx:191-218`
- **Description:** The `_Select` component is defined and unused (the
  underscore prefix is the only thing keeping the lint happy). Either
  remove it or wire it into the appearance pane that arguably needs a
  real `<select>` for languages with many entries (current Segmented does
  not scale past ~5 options).
- **Suggested fix:** Delete the function. If a future need arises, recover
  it from git.

### W2-21 · ConnectionPane defaults to read-only display; no copy buttons on baseUrl / model
- **Surface:** `src/components/SettingsDialog.tsx:723-739`
- **Description:** The base URL and default model are rendered inside
  `<code>` blocks specifically so they look copyable, but there's no copy
  affordance and selecting them with the mouse highlights the entire
  Field row. Same friction as W2-05 (CodeBlock), and these are the values
  users most often need to paste into a terminal to debug.
- **Suggested fix:** Add a hover-revealed `<IconButton>` with `<Copy>` to
  each `<code>` chunk; transient toast on copy.

### W2-22 · `Toggle` (in NotificationsPane) shows literal "On" / "Off" text after the box
- **Surface:** `src/components/SettingsDialog.tsx:419-431`
- **Description:** Each toggle renders both a checkbox AND a text label
  reading "On" / "Off". This is redundant — the checked state is the
  affordance — and creates visual noise as five toggles each show "Off
  Off Off Off Off". Compare CrashReportingField which has none of this.
- **Suggested fix:** Drop the inner span. The Field label above
  ("Permission prompts", "Question dialogs", etc.) is the description;
  the box state is the value.

### W2-23 · ImportDialog "Selected (n)" / "Select all" buttons text-only, no visual button styling
- **Surface:** `src/components/ImportDialog.tsx:142-149,174-181`
- **Description:** These are real `<button>`s but styled as muted text
  links with only a hover color change. Users may not realize they're
  clickable until they hover. The "Select group" button at the bucket
  header is right next to a chevron expand button that DOES have a
  visible hit target.
- **Suggested fix:** Use `<Button variant="ghost" size="xs">` for both,
  consistent with the rest of the app's link-button pattern (Tutorial
  back/next at line 109/138 do it this way).

### W2-24 · Button `secondary` and `ghost` focus-ring use raw white-alpha not focus-ring token
- **Surface:** `src/components/ui/Button.tsx:42,49`,
  `src/components/ui/IconButton.tsx:26,34,44`
- **Description:** Five places encode the focus halo as
  `oklch(1_0_0_/_0.06)` / `_/_0.08` literals. global.css exports
  `--color-focus-ring` for exactly this purpose; `focus-ring` /
  `focus-ring-waiting` / `focus-ring-success` utilities (#240) use the
  token. The Button/IconButton primitives — most-reused styling in the
  app — bypass the system. Theme switch (light) ends up with a
  white-on-light halo.
- **Suggested fix:** Replace `oklch(1_0_0_/_0.0X)` shadow components with
  `var(--color-focus-ring)` so the existing light-theme override flows
  through.

### W2-25 · CommandPalette `cmd:switch-theme` label can be a no-op when theme === current next
- **Surface:** `src/components/CommandPalette.tsx:148-156`
- **Description:** Label is `cmdSwitchTheme` interpolated with the next
  theme name, e.g. "Switch to light". When the user is on `system` it shows
  "Switch to dark" — but if the system *is* dark, this is confusing
  ("I'm already on dark"). The label should reflect the resolved current
  theme, not the persisted preference.
- **Suggested fix:** Compute `currentResolvedTheme` from `prefers-color-scheme`
  when persisted is `system`, then derive `nextTheme` from that.

### W2-26 · CodeBlock theme palette uses raw OKLCH for syntax tokens instead of color-syntax-* tokens
- **Surface:** `src/components/CodeBlock.tsx:7-20`
- **Description:** Nine raw OKLCH literals for syntax token colors. There
  is no token system for syntax colors yet, so every theme change to
  `bg-bg-elevated` / accent will leave code blocks rendering with
  hand-tuned colors that don't track. Light theme renders these fixed
  dark-theme syntax colors — comments at `oklch(0.55 0 0)` are gray on a
  light bg (low contrast).
- **Suggested fix:** Add `--color-syntax-{comment,string,keyword,number,
  function,type,operator}` tokens to global.css with light + dark variants,
  reference them via `var(--…)` in CodeBlock.

### W2-27 · TopBanner inner row uses `border-b` regardless of stacking with sibling banners
- **Surface:** `src/components/chrome/TopBanner.tsx:124`
- **Description:** Two banners can appear simultaneously (e.g. CLI missing
  + agent diagnostic on the same session) and each draws its own bottom
  border at the same color. Stacked, the result is a double-line between
  them and a single line under the second one — not catastrophic, but
  unpolished. Wave 1 unification gave us the chance to handle this; wave 2
  noticed it didn't.
- **Suggested fix:** Use `:not(:last-of-type)` selector on the wrapping
  AppShell banner stack (or render banners inside a single wrapper that
  applies `divide-y` once) so successive banners share a single divider.

### W2-28 · ChatStream EmptyState is just one line — no CTA or hint, post-tutorial
- **Surface:** `src/components/chat/EmptyState.tsx:1-10`
- **Description:** A fresh session with zero messages renders only "Ready
  when you are." in muted text. There is no hint that the InputBar is
  below, no shortcut-to-attach hint, no "Try /help" affordance. After
  the Tutorial dismisses, the user lands on this near-empty pane.
- **Suggested fix:** Add a secondary line under the "Ready" headline
  with a softer color: "Type your prompt below — `/help` for commands."
  (i18n key, sentence case).

---

## P2 findings

### W2-29 · `permissionPrompt.title` rendered ALL CAPS via `uppercase` Tailwind class
- **Surface:** `src/components/PermissionPromptBlock.tsx:221-223`
- **Description:** Same pattern as W2-03 (the locale string is sentence-case
  but the consumer applies `uppercase`). Lower priority because the locale
  source is correct here — this is just a note that we have a *lot* of
  `uppercase tracking-wider text-mono-xs` callers (15 by grep) and each one
  is an opportunity to drift.
- **Suggested fix:** Audit-only — consider extracting a `<MetaLabel>`
  primitive that bakes the `font-mono uppercase tracking-wider text-mono-xs`
  combo so future drift is impossible.

### W2-30 · CwdPopover header label uses `text-mono-sm uppercase` but body uses `text-mono-md`
- **Surface:** `src/components/CwdPopover.tsx:251`,
  `src/components/SlashCommandPicker.tsx:170`
- **Description:** Two adjacent popovers in the same StatusBar row use
  different mono sizes (sm in CwdPopover header, md in SlashCommandPicker
  rows). Switching between Cwd and `/` triggers a small but perceptible
  visual jolt.
- **Suggested fix:** Pick one mono size for popover headers/body and
  apply consistently across the popover family.

---

## Summary

- **P0:** 9 (W2-01 … W2-09) — i18n regressions in unified banners,
  hard-coded English in tray, missing copy button on CodeBlock, raw
  checkboxes in ImportDialog + Settings, h2/h3 visual collision.
- **P1:** 19 (W2-10 … W2-28) — token bypasses, inconsistent toggle
  treatments, dead code, missing focus-ring on jump button, error toast
  using waiting glyph, palette stagger, theme cmd label correctness.
- **P2:** 2 (W2-29 … W2-30).
- **Total:** 30 findings.

### Top 3 surprising findings (for PR teaser)

1. **W2-01** — the banner unification (#207, #237) inlined English
   strings into two of three callers instead of routing through `t()`.
   Lots of i18n work upstream of #207 was effectively undone for the CLI
   failure UX, the surface users see most when something goes wrong.
2. **W2-08** — h2 and h3 in markdown render visually identical post-#256
   (both `text-heading font-semibold`). The wave that added text-display
   for h1 didn't continue the ladder down.
3. **W2-04** — system tray menu (`Show CCSM` / `Quit`) is not
   internationalized. Anything outside the React tree was missed by every
   i18n wave so far.

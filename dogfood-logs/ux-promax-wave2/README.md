# UI/UX Pro Max wave 2 screenshots — deferred

The wave 2 audit at
`docs/design/ui-ux-pro-max-audit-2026-04-24-wave2.md` is a code-pattern
audit; every finding is observable from source (file:line cited per
finding) and does not need a repro screenshot to triage.

When the implementer fixes any **visual** P0/P1 item, capture before/after
into this directory per the `feedback_visual_fix_screenshots` rule, e.g.:

```
ux-promax-wave2/
  w2-08-h2-h3-collision-before.png
  w2-08-h2-h3-collision-after.png
  w2-10-toast-error-glyph-before.png
  w2-10-toast-error-glyph-after.png
  …
```

The existing harness scripts under `scripts/probe-*.mjs` show the playwright
+ sanitized `HOME` pattern to follow.

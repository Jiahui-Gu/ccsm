# Dev scripts

## probe-render.mjs

Runtime smoke test for the renderer. Launches headless chromium at `http://localhost:4100/`,
dumps `#root` innerHTML and any console / page errors.

Use after **any** renderer change to catch crashes that typecheck misses
(e.g. unstable Zustand selectors causing infinite rerenders).

```bash
npm run dev          # in another terminal
node scripts/probe-render.mjs
```

Pass = `#root` non-empty AND no `[error]` / `[pageerror]` lines.

## Wire-up evidence

If this PR introduces new exports / classes / handlers / sinks, fill these. If it's pure refactor / fix / test, mark `[REFACTOR-ONLY]` and skip.

- [ ] **Importers**: paste `grep -rn 'from.*<your-module>' apps/ packages/` output showing who imports each new export
- [ ] **Startup wiring** (for listeners / sinks / services / capture sources): paste the `apps/daemon/src/index.ts` (or equivalent `runStartup`) lines that call into your new code
- [ ] **Library-only marker**: if there is no startup wiring because this is a pure library task, write `[LIBRARY-ONLY]` and link the follow-up wire-up task #

## Wire-up evidence

If this PR introduces new exports / classes / handlers / sinks, fill these. If it's pure refactor / fix / test, mark `[REFACTOR-ONLY]` and skip.

- [ ] **Importers**: paste `grep -rn 'from.*<your-module>' apps/ packages/` output showing who imports each new export
- [ ] **Startup wiring** (for listeners / sinks / services / capture sources): paste the `apps/daemon/src/index.ts` (or equivalent `runStartup`) lines that call into your new code
- [ ] **Library-only marker**: if there is no startup wiring because this is a pure library task, write `[LIBRARY-ONLY]` and link the follow-up wire-up task #
- [ ] **v0.2-only growth**: if this PR modifies any file in `.v0.2-only-files`, explain why it grew (e.g. file moved, intermediate refactor) or confirm net shrink. CI guard `tools/check-v02-shrinking.sh` enforces this.

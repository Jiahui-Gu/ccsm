# R5 review — 01-overview.md

## P0
(none)

## P1

### P1-01-1. TOC lists chapters 09-15 inline in §5 reading order but does not match heading numbering
§5 lists chapter 9-14 inline in step 9 ("9. [09-crash-collector], [10-build-package-installer], [11-monorepo-layout], [12-testing-strategy], [13-release-slicing], [14-risks-and-spikes]") then chapter 15 as step 10. This is a 6-chapters-per-step cluster that downstream readers can not use as a "what to read next" guide. Split into per-chapter steps OR explicitly say "background docs in any order".

### P1-01-2. Glossary defines "Listener" as "a daemon-side socket + transport + auth-middleware bundle"
Chapter 03 §1 defines Listener as `(socket address, transport, auth middleware chain, RPC mux)`. **RPC mux is missing from the overview glossary**. P1 because a downstream worker reading the glossary alone would miss the router/mux responsibility. Align: either add "+ RPC mux" to glossary or trim chapter 03 §1.

### P1-01-3. Glossary uses "Supervisor" but does not say it is HTTP, not Connect
Chapter 03 §7 explicitly justifies "HTTP not Connect on supervisor". Glossary should hint, since reviewers reading just chapter 01 will assume Connect (the chapter only mentions Listener A as Connect).

## Notes
- §7 v0.4 delta summary correctly previews chapter 15 — bullets match audit table verdicts. Good.

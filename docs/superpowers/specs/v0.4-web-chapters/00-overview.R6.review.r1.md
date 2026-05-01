# Review of chapter 00: Overview

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P0-1 (BLOCKER): Overview contradicts every other chapter on whether the control socket runs Connect

**Where**: chapter 00, "What v0.4 ships" §2, line 20.
**Issue**: The overview states:

> "The control socket (supervisor `/healthz`, `daemon.hello`, `daemon.shutdown*`, `/stats`) **keeps its own narrower Connect surface** but stays on a separate transport"

This says the control socket runs Connect (just narrower). Every other chapter says the opposite — the control socket explicitly **stays on the v0.3 hand-rolled envelope** and is *not* moved to Connect in v0.4:

- Ch 01 N6 line 76-77: "The control socket... is **kept** as a separate transport with its own narrow allowlist... The control socket can also move to Connect later but is currently fine."
- Ch 02 §6 line 131-135: "What does NOT move to Connect (control socket stays on envelope)."
- Ch 02 §6 line 138: "1. Control socket... hand-rolled envelope, supervisor RPCs only."
- Ch 02 §8 line 184: "Why keep HMAC for the supervisor (control socket): the supervisor stays on the envelope."
- Ch 05 §5 line 143: control socket auth = "peer-cred + HMAC (v0.3 carryover)" (HMAC is the envelope handshake; Connect doesn't use it).
- Ch 09 M2 line 23: "control socket (supervisor) untouched."
- Ch 11 line 37: "`daemon/src/dispatcher.ts` ... Unchanged in v0.4 (control socket stays envelope)."

**Why this is P0**: An implementer reading the overview alone would scaffold a Connect server on the control socket; an implementer reading 02-§6 would not. They would build different things. The overview is the front door of the spec — getting this wrong here primes every subsequent reading with the wrong mental model.

**Suggested fix**: Replace "keeps its own narrower Connect surface but stays on a separate transport" with:

> "stays on the v0.3 hand-rolled envelope on a separate transport (per chapter 02 §6 — moving the supervisor surface to Connect is a v0.5 housekeeping item)."

### P1-1 (must-fix): Bridge-call count ("~22") in overview is the deprecated figure; chapter 03 explicitly retires it as an undercount

**Where**: chapter 00, "What v0.4 ships" §3, line 21: "Bridge swap, all 22 calls — every `ipcRenderer.invoke('foo', ...)` in `electron/preload/bridges/*.ts` is replaced".
**Issue**: Chapter 03 §1 line 31 writes:

> "Totals: 31 unary, 4 fire-and-forget, 11 streams = **46 cross-boundary calls**. (The '~22 IPC bridges' figure in the predecessor design doc was an undercount; v0.4 inventory is canonical going forward.)"

Chapter 09 M2 line 23 also uses 46 ("~46 bridge calls"). Chapter 02 §6 line 139 still uses the stale "~22 bridge RPCs". Chapter 01 G3 line 27 also uses "~22 IPC calls". Overview should reflect the canonical number.

**Why P1**: The number is load-bearing for scope estimation. Two figures in the same spec (~22 vs ~46) make M2 effort estimation, batch sizing (chapter 03 §5 splits into A/B/C), and PR count budget (chapter 03 §5 line 125 "~12 PRs across the swap") incoherent.

**Suggested fix**: Change "all 22 calls" to "all 46 calls" in 00 §3. Cross-chapter rename — also fix 01 G3 line 27 ("~22 IPC calls") and 02 §6 line 139 ("All ~22 bridge RPCs"). See cross-file findings.

### P2-1 (nice-to-have): "Web client" vs "web client" capitalization drift

**Where**: chapter 00, lines 3, 19, 22, 35, 37, 39, 59 use "Web client" (capitalized W). Chapters 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11 (and even chapter 04's own §1 prose) use "web client" lowercase. The doc map at line 59 says "04 Web client" but chapter 04's H1 is "Web client" — fine — its §1 prose uses lowercase.
**Issue**: The overview is the only chapter that consistently capitalizes "Web client". One term, one casing.
**Suggested fix**: lowercase "web client" everywhere in chapter 00 (matches 99% of the doc). Keep the doc-map entry "04 Web client" as a title (proper-noun-like usage in a TOC is fine).

### P2-2 (nice-to-have): Placeholder hostname format inconsistent across chapters

**Where**: across the doc:
- 00 line 28: `app.<author-domain>`
- 01 line 47: `daemon.<user-domain>`
- 04 line 5: `app.<author-domain>`
- 05 line 56: `daemon.<their-domain>`
- 05 line 62: `app.<their-domain>`
- 07 line 56, 63: `app.<domain>`
- 09 line 25: `app.<domain>`
- 09 line 123: `app.<author-domain>` and `<deploy>.pages.dev`
- 05 line 62: `<project>.pages.dev`

**Issue**: Five different placeholder strings (`<author-domain>`, `<user-domain>`, `<their-domain>`, `<domain>`, `<deploy>` + `<project>`) for the same two concepts (the user's owned domain; the Pages project URL). Reader unfamiliar with the spec can't tell whether these denote different things.
**Why P2 not P1**: doesn't change implementation; readability harm only.
**Suggested fix**: pick one placeholder per concept and apply globally:
- `app.<your-domain>` for the user's web-client custom domain.
- `daemon.<your-domain>` for the user's tunnel custom domain.
- `<project>.pages.dev` for the auto-assigned Pages URL.
- `<random>.cfargotunnel.com` for the auto-assigned tunnel URL (already consistent).

This is a cross-file finding (touches 00, 01, 04, 05, 07, 09); flag for one fixer.

## Cross-file findings (if any)

- See P1-1 above: rename `~22` → `~46` across 00 §3, 01 G3, 02 §6 in one fixer to keep the count coherent.
- See P2-2 above: placeholder hostname normalization is a 6-chapter rename — should be one fixer.
- See P0-1 above: overview's wrong claim about control socket should be the only fix needed, but the fixer should also re-read chapter 11's `daemon/src/dispatcher.ts` row to confirm "control socket stays envelope" terminology is the canonical phrasing to use.

# Review of chapter 01: Cutover audit

Reviewer: R2 (security)
Round: 1

## Findings

No P0/P1/P2 from R2 security.

Audit is purely a hot-path inventory + FIX/KEEP/REVERT verdicts on existing surfaces. HP-11 (`daemon/api/index.ts` auto-registry) and HP-12 (daemon shutdown lifecycle) are correctly KEEP — both are wave-2 substrate, no scope creep here.

Note (not a finding): HP-11's auto-registry pattern (`require every daemon/api/*.js sibling at boot`) is a supply-chain consideration if a fixer adds a new `daemon/api/*.ts` file in a later PR — anything in that directory will be auto-loaded into the loopback HTTP routing table. v0.3 PR set (chapter 05) does not add new `daemon/api/*` files, so no v0.3 risk. Recommend tracking as a v0.4 hardening item (route allow-list) if/when web frontend lands.

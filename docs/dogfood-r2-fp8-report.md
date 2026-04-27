# Dogfood r2 fp8 — tool-call rendering report

Branch: dogfood-r2-fp8 | HEAD: (local) | Date: 2026-04-27T05:19:04.597Z
Installer reused from pool-6 (commit dc9dad9).
Screenshots: docs/screenshots/dogfood-r2/fp8-tools/

## fp8: PARTIAL

- Check A: **PARTIAL** — tool=Read got=false blocks=1
- Check B: **PASS** — prompt=true bashBlock=true expandClicked=true
- Check C: **PARTIAL** — prompt=false editBlock=true diskHasWorld=false
- Check D: **PASS** — prompt=true writeBlock=true diskExists=true
- Check E: **PASS** — grepBlock=true
- Check F: **PARTIAL** — readBlocks=0 totalBlocks=0

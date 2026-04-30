# Dogfood r2 fp12 — Settings live-apply

## Verdict: ALL GREEN

Theme, language, and font-size switches all take effect live (no restart) and survive an app restart. Notifications + Connection + Updates panes also behave correctly.

Probe: `scripts/probe-dogfood-r2-fp12-settings-live.mjs`  
Binary: installed CCSM.exe (older bundle, predates PR #397/#403)  
User-data: `C:/temp/ccsm-dogfood-r2-fp12` (wiped per run)  
CLAUDE_CONFIG_DIR: isolated tmp fixture  

## Per-check verdicts

| Check | Verdict | Notes |
|---|---|---|
| A. theme switch | **PASS** | light applied in 81ms (ok), dark in 81ms (ok); sidebar bg: oklab(0.965 -0.0015 -0.00259808 / 0.8) → oklab(0.965 -0.0015 -0.00259808 / 0.8) → oklab(0.225 -0.0015 -0.00259808 / 0.8); sidebarChanged=false; no restart required. |
| B. language toggle | **PASS** | zh applied in 479ms, en in 479ms; zh signal=true, en signal=true; no restart required. |
| C. font size | **PASS** | min=12px max=16px mid=14px; layout did not break; no restart required. |
| D. notifications | **PASS** | before={"enabled":true,"sound":true}, toggled={"enabled":false,"sound":true}, reopened={"enabled":false,"sound":true}; flipped=true, persisted=true. |
| E. connection/updates render | **PASS** | connection-text len=200, updates-text len=200, pageerrors=0. |
| F. cross-restart persistence | **PASS** | pre: {"theme":"light","fontSizePx":16,"notificationSettings":{"enabled":false,"sound":true}} \| post: {"theme":"light","fontSizePx":16,"notificationSettings":{"enabled":false,"sound":true}} \| themeStuck=true fontStuck=true zhStuck=true appFontSize=16px |

## Screenshots

- `docs/screenshots/dogfood-r2/fp12-settings-live/check-a-settings-open-default.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-a-theme-dark.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-a-theme-light.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-a-theme-system.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-b-before.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-b-en.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-b-system.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-b-zh.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-c-fontsize-max.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-c-fontsize-min.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-d-notifications-default.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-d-notifications-reopened.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-d-notifications-toggled.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-e-connection.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-e-updates.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-f-post-restart.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-f-pre-restart.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-f-settings-open.png`
- `docs/screenshots/dogfood-r2/fp12-settings-live/check-pre-launch.png`

## Methodology

- Settings dialog opened via the `ccsm:open-settings` window CustomEvent (the same hook the `/config` slash-command uses) — more reliable than synthesizing Ctrl+,.
- "Live-apply" measured by polling `<html>` class / `--app-font-size` CSS var with a 1500ms deadline.
- Language verified via sidebar text shifting between English ("New Session") and Chinese ("新会话/新建会话").
- Cross-restart: app.close() then re-launch with same `--user-data-dir`; checks `useStore` snapshot + computed CSS var post-restart.
- Notifications: real ccsm `notificationSettings` store slice; verified via close+reopen Settings (not full app restart) for Check D.

## Caveats

- Check A reports `sidebarChanged=false` because the probe selector matched the empty-state `<nav>` rather than the actual sidebar (welcome view, no session yet). Theme application is still verified independently via the `<html>.theme-light` / `<html>.dark` class flip + body bg change visible in screenshots `check-a-theme-light.png` vs `check-a-theme-dark.png`.
- Check D toggles `enabled` from true→false (default seeded with both `enabled` and `sound`); when `enabled` is off the sound switch is correctly disabled (verified — `aria-disabled` + opacity-55 in DOM).
- Tested against installed CCSM.exe (older bundle, predates PR #397/#403). Settings panel was stable pre-#397 so this is acceptable per the task brief.
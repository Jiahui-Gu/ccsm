# v0.3 README screenshots

Capture list for the v0.3 ship-ready README rewrite. Take each shot, save as a
PNG with the exact filename listed below into this directory
(`docs/screenshots/v0.3-readme/`). The README already references these paths;
once the files exist, the embeds resolve automatically.

General guidance:

- **Theme**: dark mode for hero, light mode for one supporting shot (so both
  themes are represented). Set via Settings -> Appearance.
- **Font size**: Medium (default).
- **Window chrome**: native frame OK. Crop to the app window only (no desktop
  background). On Windows use `Alt+PrintScreen` or Snipping Tool window mode.
- **Sensitive data**: rename groups/sessions to neutral demo names before
  capturing. No real API keys, no real internal repo paths.
- **Format**: PNG, no compression artifacts. Retina/2x is fine but keep file
  size under ~600 KB (run through `oxipng` or similar if larger).
- **Window size**: 1440x900 unless otherwise noted (matches MacBook default
  and crops well on GitHub README rendering).

---

## 1. `01-hero.png` — Main window, multi-session view

- **Recommended size**: 1440x900.
- **Theme**: dark.
- **Setup**:
  - Sidebar visible with 2 groups, e.g. "ccsm" and "scratch".
  - 3-4 sessions across those groups; at least one with the breathing amber
    "waiting" dot to demonstrate the lifecycle signal.
  - Right pane: an active chat with a few user/assistant blocks visible
    (mixed text + a collapsed tool call) so the CLI-grade density reads.
  - Status bar at bottom showing cwd chip, model name, permission mode, and
    context %.
- **Crop**: full app window.

## 2. `02-quickstart-new-session.png` — New session popover

- **Recommended size**: 1280x800 (smaller is fine, cropped tight).
- **Theme**: dark.
- **Setup**:
  - Click the "+ New session" button in a group; popover open with the cwd
    picker showing 2-3 recent directories.
- **Crop**: include the sidebar group header + the popover; trim empty space.

## 3. `03-permission-prompt.png` — Inline permission block

- **Recommended size**: 1280x800.
- **Theme**: dark.
- **Setup**:
  - A session where the agent has just requested a `Bash` or `Write` tool.
  - The permission block at the tail of the conversation shows the tool name,
    structured input (command + cwd), and Allow / Allow always / Deny.
- **Crop**: chat pane only; sidebar can be trimmed.

## 4. `04-command-palette.png` — Search / command palette

- **Recommended size**: 1280x800.
- **Theme**: light (so README has at least one light-theme shot).
- **Setup**:
  - Press `Ctrl+F` (or `Cmd+F`) to open the palette.
  - Type a partial query that returns mixed results: a session name, a group
    name, and one of the built-in commands (e.g. "Switch theme").
- **Crop**: full window or just the palette overlay with a faint backdrop.

## 5. `05-status-bar.png` — Status bar detail (cwd / model / mode / context)

- **Recommended size**: 1280x200 (a wide, short strip).
- **Theme**: dark.
- **Setup**:
  - One session open; hover the permission-mode chip so the tooltip is
    visible (shows "Default - auto-approve reads; ask before edits and
    shell.").
- **Crop**: just the status bar plus the bottom edge of the chat area for
  context. The tooltip should be inside the crop.

## 6. `06-notifications.png` — OS toast (optional, nice-to-have)

- **Recommended size**: native toast resolution; capture the toast plus a
  sliver of the app behind it.
- **Theme**: matches OS; dark Windows 11 looks best.
- **Setup**:
  - Trigger a `permission` or `turn_done` notification while the CCSM window
    is unfocused (Alt+Tab to another app, then trigger).
  - Capture the resulting OS toast (Windows: Action Center / right-corner
    pop; macOS: top-right banner).
- **Crop**: toast plus minimal context. If this shot is awkward to capture,
  it can be skipped without breaking the README (the corresponding embed
  uses a TODO comment fallback).

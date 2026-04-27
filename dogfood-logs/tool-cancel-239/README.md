# Tool cancel IPC (#239) — visual evidence

## Status

Screenshots were not captured in the worker sandbox — the worker
environment had Electron/native-module issues that prevented launching
the app to capture before/after PNGs of the ToolBlock cancel link.

The reviewer should run the existing render harness locally (`npm run
dev` then chat → trigger a stalled tool > 90s) to capture:

- `before.png` — Cancel link in idle state (warning text color, hover
  underlines)
- `hover.png` — Cancel link with cursor over (underline visible)
- `cancelling.png` — Cancel link in disabled "Cancelling…" state after
  click (italic, fg-tertiary tone, `aria-disabled="true"`)

## Visual contract (frozen by tests)

- Idle text: localized `chat.toolStallCancel` (en: "Cancel", zh: "取消")
- aria-label: localized `chat.toolStallCancelAria` (en: "Cancel tool",
  zh: "取消工具")
- After-click text: localized `chat.toolStallCancelling` (en:
  "Cancelling…", zh: "取消中…")
- After-click attribute: `aria-disabled="true"` and `tabIndex={-1}`
- focus-ring class always present (verified by RTL test
  `tests/chatstream-tool-block-ux.test.tsx`).

The unit test in `tests/chatstream-tool-block-ux.test.tsx::"clicking
Cancel after 90s invokes agentCancelToolUse"` exercises every visual
state transition above.

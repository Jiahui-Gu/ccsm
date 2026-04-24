import type { MessageBlock } from '../../types';

// Tool families that get specialized renderers in ToolBlock.
export const FILE_TREE_TOOLS = new Set(['Glob', 'LS']);

// Tool names whose output is a shell stream (raw text, often with ANSI
// escapes). We render these in xterm so colors/cursor moves render properly
// instead of leaking as literal `\u001b[...m` noise.
export const SHELL_OUTPUT_TOOLS = new Set(['Bash', 'BashOutput']);

// Tiered stall thresholds for in-flight tool blocks (#181, #208).
//
//   STALL_HINT_AFTER_MS (30s, #181):
//     Subtle italic hint "(taking longer than usual…)" next to the elapsed
//     counter. Counter color stays neutral. Just an FYI — most tools at this
//     point are still legitimately working.
//
//   STALL_ESCALATE_AFTER_MS (90s, #208):
//     Louder warning. Elapsed-time chip flips to warning color and a Cancel
//     link surfaces inline. The Cancel link does NOT yet wire to a real
//     stop-tool IPC (no per-tool-use cancel exists today; the Stop button in
//     StatusBar interrupts the whole turn). Today the link emits a
//     `console.warn` with the tool name so developers can see the user
//     intent in logs. TODO(#208-followup): wire to a real cancel-tool IPC
//     once the agent SDK exposes one — tracked separately so this PR can
//     ship the visual escalation without a backend change.
//
//   STALL_DROP_AFTER_MS (120s, documented but not implemented):
//     Future "stalled — likely dropped" red-state. Spec'd here so the next
//     person knows the intended ladder. Skipped this round because picking
//     a correct cutoff and a correct recovery (drop the block? request the
//     agent to retry? leave to user?) is non-trivial and out of #208 scope.
export const STALL_HINT_AFTER_MS = 30_000;
export const STALL_ESCALATE_AFTER_MS = 90_000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documented future tier, see comment above
export const STALL_DROP_AFTER_MS = 120_000;

// Long-output viewer tiers (see LongOutputView).
export const LONG_STRING_THRESHOLD = 200;
export const COLLAPSED_HEAD = 50;
export const COLLAPSED_TAIL = 50;
export const VIEWPORT_LINES = 200; // window mount budget when expanded
export const VIEWPORT_OVERSCAN = 30;
export const LINE_HEIGHT_PX = 18;
export const VIEWPORT_HEIGHT_PX = 360;
export const MAX_INLINE_BYTES = 10 * 1024 * 1024;

// Auto-follow heuristic: consider the user "at the bottom" if they're within
// this many pixels of the actual scrollHeight. Anything larger and we assume
// they've scrolled up intentionally and stop following.
export const FOLLOW_THRESHOLD_PX = 32;

// Stable empty-array reference so the store selector doesn't churn when a
// session has no messages yet.
export const EMPTY_BLOCKS: readonly MessageBlock[] = [];

export type PtyExitKind = 'clean' | 'crashed';

/**
 * Pure decider: classify a pty exit event as clean or crashed.
 *
 * The active-pane overlay (TerminalPane) and the sidebar red-dot signal
 * (store.disconnectedSessions) must agree, so both call sites share this
 * single source of truth.
 *
 * Rule: clean iff signal is absent AND exit code is exactly 0.
 * Anything else (any signal present, non-zero code, or both null) is a crash.
 *
 * | code     | signal       | result    |
 * | -------- | ------------ | --------- |
 * | 0        | null         | clean     |
 * | 0        | SIGTERM      | crashed   |
 * | non-zero | any          | crashed   |
 * | null     | SIGKILL      | crashed   |
 * | null     | null         | crashed   |
 *
 * Note: signal accepts `string | number | null` to match both upstream
 * shapes — store payloads use `string | number | null`, the IPC bridge
 * may surface either depending on platform (POSIX name vs numeric code).
 */
export function classifyPtyExit({
  code,
  signal,
}: {
  code: number | null;
  signal: string | number | null;
}): PtyExitKind {
  return signal == null && code === 0 ? 'clean' : 'crashed';
}

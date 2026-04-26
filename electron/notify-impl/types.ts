// Public payload + event types for the inlined notify module.
//
// Originally vendored from the standalone `@ccsm/notify` package (v0.1.1).
// All emit methods are unconditional — caller is responsible for suppression
// (focused-active session, user-disabled toggles). The toastId is owned by
// the caller and must be unique across pending notifications.

/** Payload for `Notifier.permission`. */
export interface PermissionPayload {
  /** Unique id used to correlate the action callback. Caller-owned. */
  toastId: string;
  /** Display name of the session asking for permission. */
  sessionName: string;
  /** Tool name, e.g. "Bash", "Write". */
  toolName: string;
  /** Short summary of what the tool wants to do (truncated for display). */
  toolBrief: string;
  /** Basename of the cwd, shown as attribution. */
  cwdBasename: string;
}

/** Payload for `Notifier.question` — passive notification, no in-toast actions. */
export interface QuestionPayload {
  toastId: string;
  sessionName: string;
  /** The question text (truncated for display). */
  question: string;
  /** Whether the user must pick one or many options in-app. */
  selectionKind: 'single' | 'multi';
  /** Number of options the user will see in-app. */
  optionCount: number;
  cwdBasename: string;
}

/** Payload for `Notifier.done` — passive completion notification. */
export interface DonePayload {
  toastId: string;
  /** Group / task name (top-level user concept). */
  groupName: string;
  /** Session name (sub-task). */
  sessionName: string;
  /** Last user message in the conversation, prefixed with "> " on display. */
  lastUserMsg: string;
  /** Last assistant message in the conversation. */
  lastAssistantMsg: string;
  /** Wall-clock duration of the completed run in milliseconds. */
  elapsedMs: number;
  /** Number of tool calls executed during the run. */
  toolCount: number;
  cwdBasename: string;
}

/**
 * Action ids dispatched from a toast back to the host app.
 *
 * - `allow` / `allow-always` / `reject` — permission toast buttons
 * - `focus` — body click on any toast (also dismiss-then-focus)
 */
export type ActionId = 'allow' | 'allow-always' | 'reject' | 'focus';

/** Args bag carried in the toast `launch=` URL, parsed into a flat record. */
export type ActionArgs = Record<string, string>;

/** Event delivered to `NotifierOptions.onAction`. */
export interface ActionEvent {
  toastId: string;
  action: ActionId;
  args: ActionArgs;
}

/** Constructor options for `Notifier.create`. */
export interface NotifierOptions {
  /** Application User Model ID. Required on Windows for toast routing. */
  appId: string;
  /** Display name of the host app, shown in toast attribution chrome. */
  appName: string;
  /** Absolute path to a square PNG icon shown on the toast. */
  iconPath?: string;
  /** Mute the Windows default notification sound. */
  silent?: boolean;
  /**
   * Single dispatch point for all toast interactions. The notifier auto-
   * dismisses the toast after this callback returns.
   */
  onAction: (event: ActionEvent) => void;
}

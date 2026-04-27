/**
 * Shared session-layer types + small helpers consumed by the SDK-backed
 * runner (`electron/agent-sdk/sessions.ts`), the IPC manager
 * (`electron/agent/manager.ts`), and the main/preload boundary.
 *
 * History: this file used to host the hand-written `SessionRunner` class
 * that drove `claude.exe` directly via spawn + NDJSON. That implementation
 * was removed once the `@anthropic-ai/claude-agent-sdk` runner reached
 * parity (see PR-A / PR-B). What remains here is the contract surface —
 * everything other modules import as a type — plus `resolveCwd`, which
 * still has a single non-runner caller in `main.ts`.
 */

import os from 'node:os';
import path from 'node:path';
import type { ClaudeStreamEvent } from './stream-json-types';

export type { StartErrorCode, StartResult } from './start-result-types';

// Permission mode accepted across the IPC boundary. Values match the CLI's
// `--permission-mode` flag 1:1 — the renderer's `PermissionMode` enum is
// already aligned, so no translation is needed.
//
// We still accept legacy UI-only modes (`'dontAsk'`, `'auto'`, and the older
// `'ask'` / `'yolo'` / `'standard'`) here so an older renderer build doesn't
// break the runner.
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto'
  | 'ask'
  | 'yolo'
  | 'standard';

// IPC payload mirrors the on-wire stream-json events from claude.exe stdout.
// SDK-side messages are translated into this same shape by
// `electron/agent-sdk/sdk-message-translator.ts` so renderer code stays
// runner-agnostic.
export type AgentMessage = ClaudeStreamEvent;

export function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}

export type StartOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  /**
   * Per-session env overrides layered onto the runner's baseline. Used to
   * pipe an endpoint's ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY /
   * ANTHROPIC_AUTH_TOKEN into the child so each session can target a
   * different endpoint.
   */
  envOverrides?: Record<string, string>;
  /**
   * Optional override for `CLAUDE_CONFIG_DIR`. When unset, CCSM uses the
   * user's real `~/.claude/` so login state is shared with the CLI.
   */
  configDir?: string;
  /**
   * Pre-resolved claude binary path. When set, the runner skips PATH lookup.
   * Populated by main.ts from the persisted `claudeBinPath` state (user's
   * "Browse for binary..." pick in the first-run wizard).
   */
  binaryPath?: string;
  /**
   * Resolved effort level for this session at launch. Drives `query()`'s
   * `thinking` (adaptive/disabled) + `effort` options. The 6-tier chip
   * resolves to this value via per-session-override OR globalEffortLevel
   * fallback in `src/agent/startSession.ts`. Optional for back-compat with
   * harness probes that don't supply it; runner falls back to 'high'.
   */
  effortLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

export type EventHandler = (msg: AgentMessage) => void;
export type ExitHandler = (info: { error?: string }) => void;
export type PermissionRequestHandler = (req: {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => void;
/**
 * Transient diagnostics surfaced from the agent layer — things the user may
 * want to see as a toast (init handshake failed, outbound control_request
 * timed out) but which aren't hard session-ending errors. Kept deliberately
 * minimal: `code` is a stable machine-readable key (e.g. `init_failed`,
 * `control_timeout`), `message` is a one-liner suitable for toast copy.
 */
export type DiagnosticHandler = (d: {
  level: 'warn' | 'error';
  code: string;
  message: string;
}) => void;

export type { ClaudeStreamEvent };

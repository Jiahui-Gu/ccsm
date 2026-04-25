/**
 * Feature-flag dispatch between the legacy hand-written runner
 * (electron/agent/sessions.ts SessionRunner) and the SDK-backed runner
 * (electron/agent-sdk/sessions.ts SdkSessionRunner).
 *
 * Why a single factory function (not if/else inside manager.ts):
 *   - One place reads the env var, so the flag can't be partially applied
 *     across IPC handlers.
 *   - Read at runtime (not module load) so tests can flip the env var per
 *     test case via vi.stubEnv without re-importing the manager.
 *   - The `Runner` type below is the contract the manager actually uses;
 *     either implementation must satisfy it. If a method drifts on one side
 *     a TS error fires here, not at the call site.
 *
 * Default behaviour: legacy path. The new path activates only when
 * `CCSM_USE_SDK` is set to a truthy value (`1` / `true` / `yes`). Anything
 * else — unset, empty, `0`, `false`, `no` — keeps the legacy runner.
 */

import {
  SessionRunner,
  type StartOptions,
  type PermissionMode,
  type AgentMessage,
  type EventHandler,
  type ExitHandler,
  type PermissionRequestHandler,
  type DiagnosticHandler,
} from '../agent/sessions';
import { SdkSessionRunner } from './sessions';

/**
 * Duck-typed runner contract used by SessionsManager. Both
 * `SessionRunner` (legacy) and `SdkSessionRunner` (SDK) satisfy this
 * structurally — the type assertion in createRunner enforces that at
 * compile time.
 */
export interface Runner {
  readonly id: string;
  getPid(): number | undefined;
  start(opts: StartOptions): Promise<void>;
  send(text: string): void;
  sendContent(content: readonly unknown[]): void;
  interrupt(): Promise<void>;
  cancelToolUse(toolUseId: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean;
  resolvePermissionPartial(requestId: string, acceptedHunks: number[]): boolean;
  close(): void;
}

/**
 * Re-export the types the manager already imports so call sites can stay
 * agnostic to which runner is in play.
 */
export type {
  StartOptions,
  PermissionMode,
  AgentMessage,
  EventHandler,
  ExitHandler,
  PermissionRequestHandler,
  DiagnosticHandler,
};

/**
 * Returns true when the SDK-backed runner should be used. Re-evaluated on
 * each call so tests can flip the env between sessions.
 */
export function isSdkRunnerEnabled(): boolean {
  const v = process.env.CCSM_USE_SDK;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes';
}

export function createRunner(
  sessionId: string,
  onEvent: EventHandler,
  onExit: ExitHandler,
  onPermissionRequest: PermissionRequestHandler,
  onDiagnostic: DiagnosticHandler = () => {},
): Runner {
  if (isSdkRunnerEnabled()) {
    return new SdkSessionRunner(
      sessionId,
      onEvent,
      onExit,
      onPermissionRequest,
      onDiagnostic,
    );
  }
  return new SessionRunner(
    sessionId,
    onEvent,
    onExit,
    onPermissionRequest,
    onDiagnostic,
  );
}

import type { WebContents } from 'electron';
import type { StartOptions, PermissionMode, AgentMessage } from './sessions';
import { ClaudeNotFoundError } from './binary-resolver';
import type { StartResult } from './start-result-types';
import { SdkSessionRunner } from '../agent-sdk/sessions';

/**
 * Runner contract used by SessionsManager. The hand-written legacy runner
 * (`SessionRunner`) was removed in PR-C; `SdkSessionRunner` is now the only
 * implementation. The interface is kept explicit so a future second runner
 * (or a test fake) drops in without retouching the manager.
 */
interface Runner {
  readonly id: string;
  getPid(): number | undefined;
  start(opts: StartOptions): Promise<void>;
  send(text: string): void;
  sendContent(content: readonly unknown[]): void;
  interrupt(): Promise<void>;
  cancelToolUse(toolUseId: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(tokens: number): Promise<void>;
  /**
   * Push a 6-tier effort chip change into a live session. Implementation
   * dispatches the two SDK control RPCs concurrently — see
   * `electron/agent-sdk/sessions.ts:setEffort`.
   */
  setEffort(level: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): Promise<void>;
  resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean;
  resolvePermissionPartial(requestId: string, acceptedHunks: number[]): boolean;
  close(): void;
}

export type { StartErrorCode, StartResult } from './start-result-types';

type Sender = (channel: string, payload: unknown) => void;

/**
 * Diagnostic surfaced from the agent subsystem that the renderer can toast.
 * Emitted on new `agent:diagnostic` channel — separate from `agent:exit` so
 * transient warnings (init-handshake failure, outbound control_request timeout)
 * don't look like hard session termination.
 */
export type AgentDiagnostic = {
  sessionId: string;
  level: 'warn' | 'error';
  code: string;
  message: string;
};

/**
 * Per-model capability metadata reported by the SDK after session start.
 * Drives the StatusBar effort chip's tier gating — see
 * `src/agent/effort.ts::supportedEffortLevelsForModel` for the
 * fallback table used when a model is absent from this report.
 */
export type AgentModelInfoEvent = {
  sessionId: string;
  models: Array<{
    modelId: string;
    supportedEffortLevels?: ReadonlyArray<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  }>;
};

class SessionsManager {
  private runners = new Map<string, Runner>();
  private sender: Sender | null = null;
  // Test-only counter incremented when a runner's onExit callback fires
  // *before* close()/closeAll() removed it from the map — i.e. the CLI
  // self-crashed/exited rather than being torn down by the manager. Read
  // by the close-window / delete-session probes via `__ccsmDebug` to
  // distinguish "count went to 0 because handler worked" (counter unchanged)
  // from "count went to 0 because CLI happened to die" (counter incremented).
  // Has no production read path.
  private selfExitCount = 0;

  bindSender(wc: WebContents): void {
    this.sender = (channel, payload) => {
      // Guard every send: the WebContents may be torn down mid-flight (window
      // hidden→destroyed on minimize-to-tray → reshow creates a new one; the
      // old reference here dangles until we rebind). wc.send on a destroyed
      // WebContents throws, which would propagate into the sessions event
      // loop and potentially kill an otherwise-healthy runner.
      if (wc.isDestroyed()) return;
      try {
        wc.send(channel, payload);
      } catch {
        /* WebContents went away between isDestroyed() and send() — swallow */
      }
    };
  }

  /**
   * Point future emits at a fresh WebContents. Called from main.ts whenever a
   * BrowserWindow is (re)created so sessions that outlived a window hide/show
   * cycle keep streaming into the live renderer instead of into a dead
   * reference. Idempotent; replaces any prior sender.
   */
  rebindSender(wc: WebContents): void {
    this.bindSender(wc);
  }

  /**
   * Expose runner metadata for the dev-only debug backdoor in main.ts.
   * Never call from production code — this is strictly for E2E probes that
   * need to assert on the live child pid set. Returns a snapshot; mutating
   * the array has no effect on the real runner map.
   */
  activeRunnerPids(): Array<{ sessionId: string; pid: number | undefined }> {
    const out: Array<{ sessionId: string; pid: number | undefined }> = [];
    for (const [sessionId, runner] of this.runners) {
      out.push({ sessionId, pid: runner.getPid() });
    }
    return out;
  }

  activeSessionCount(): number {
    return this.runners.size;
  }

  /**
   * Test-only: total count of CLI self-exits observed since process start.
   * Probes baseline this before triggering the path under test, then assert
   * it didn't move during the poll window — otherwise their `count → 0`
   * assertion could be satisfied by an unrelated CLI crash instead of the
   * close handler. Read via `__ccsmDebug.selfExitCount()`.
   */
  selfExitsSinceStart(): number {
    return this.selfExitCount;
  }

  async start(sessionId: string, opts: StartOptions): Promise<StartResult> {
    if (this.runners.has(sessionId)) return { ok: true };
    // Race the SDK consumer's first signal (event = healthy, exit = early
    // failure) against an ~800ms window so a CLI that spawns and immediately
    // exits 1 (stale binPath, missing dep, bad shim) surfaces as a typed
    // CLI_SPAWN_FAILED on the agent:start return instead of an unexplained
    // ok:true followed by a silent agent:exit. Mirrors the legacy runner's
    // detectEarlyFailure behaviour the renderer banner contract depends on.
    let settled = false;
    let earlyError: string | undefined;
    let signalFirst: (() => void) | null = null;
    const firstSignal = new Promise<void>((r) => { signalFirst = r; });
    const wakeFirst = () => { if (signalFirst) { signalFirst(); signalFirst = null; } };
    try {
      const runner: Runner = new SdkSessionRunner(
        sessionId,
        (msg: AgentMessage) => {
          if (!settled) wakeFirst();
          this.emit('agent:event', { sessionId, message: msg });
        },
        ({ error }) => {
          if (!settled) {
            earlyError = error ?? 'Claude CLI exited before producing output.';
            wakeFirst();
            return;
          }
          this.emit('agent:exit', { sessionId, error });
          // Discriminate self-exit (CLI crashed) from manager-driven teardown:
          // close()/closeAll() delete from `runners` *before* this callback
          // fires, so `has(sessionId)` is true only on the self-exit path.
          if (this.runners.has(sessionId)) this.selfExitCount += 1;
          this.runners.delete(sessionId);
        },
        (req) => this.emit('agent:permissionRequest', { sessionId, ...req }),
        (diag) =>
          this.emit('agent:diagnostic', {
            sessionId,
            level: diag.level,
            code: diag.code,
            message: diag.message,
          } satisfies AgentDiagnostic),
        (info) =>
          this.emit('agent:modelInfo', {
            sessionId,
            models: info.models,
          } satisfies AgentModelInfoEvent)
      );
      await runner.start(opts);
      await Promise.race([firstSignal, new Promise<void>((r) => setTimeout(r, 800))]);
      settled = true;
      if (earlyError !== undefined) {
        try { runner.close(); } catch { /* ignore */ }
        return {
          ok: false,
          error: 'Failed to start Claude',
          errorCode: 'CLI_SPAWN_FAILED',
          detail: earlyError,
        };
      }
      this.runners.set(sessionId, runner);
      return { ok: true };
    } catch (err) {
      settled = true;
      if (err instanceof ClaudeNotFoundError) {
        return {
          ok: false,
          error: err.message,
          errorCode: 'CLAUDE_NOT_FOUND',
          searchedPaths: err.searchedPaths,
        };
      }
      return {
        ok: false,
        error: 'Failed to start Claude',
        errorCode: 'CLI_SPAWN_FAILED',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  send(sessionId: string, text: string): boolean {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    r.send(text);
    return true;
  }

  /**
   * Forward a prebuilt Anthropic content-block array (text + image blocks
   * etc.) to the session's stdin. Used by image drop/paste flows.
   */
  sendContent(sessionId: string, content: readonly unknown[]): boolean {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    r.sendContent(content);
    return true;
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    await r.interrupt();
    return true;
  }

  /**
   * (#239) Per-tool-use cancel. Returns false when the session can't be
   * found so the IPC layer can surface `{ok:false, error:'no_session'}`
   * to the renderer (matches the existing setPermissionMode error shape).
   * The toolUseId is forwarded to the runner where it's logged today and
   * used for scoped cancel once the SDK supports it.
   */
  async cancelToolUse(sessionId: string, toolUseId: string): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    await r.cancelToolUse(toolUseId);
    return true;
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    await r.setPermissionMode(mode);
    return true;
  }

  async setModel(sessionId: string, model?: string): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    await r.setModel(model);
    return true;
  }

  /**
   * Push the resolved `max_thinking_tokens` value into the running SDK
   * session. Returns false when the session is gone so the IPC handler can
   * surface `{ok:false, error:'no_session'}` (matches setPermissionMode).
   */
  async setMaxThinkingTokens(sessionId: string, tokens: number): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    await r.setMaxThinkingTokens(tokens);
    return true;
  }

  /**
   * Push a 6-tier effort chip change into the running SDK session. The
   * runner concurrently dispatches `setMaxThinkingTokens` (legacy/thinking
   * dimension) + `applyFlagSettings({effortLevel})` (effort dimension).
   * Returns false when the session is gone (mirrors setMaxThinkingTokens).
   */
  async setEffort(
    sessionId: string,
    level: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  ): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    await r.setEffort(level);
    return true;
  }

  resolvePermission(sessionId: string, requestId: string, decision: 'allow' | 'deny'): boolean {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    return r.resolvePermission(requestId, decision);
  }

  /**
   * Per-hunk partial-accept variant of resolvePermission (#251).
   * `acceptedHunks` indices map to the `DiffSpec.hunks` produced by
   * `src/utils/diff.ts` for the original tool call.
   */
  resolvePermissionPartial(
    sessionId: string,
    requestId: string,
    acceptedHunks: number[]
  ): boolean {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    return r.resolvePermissionPartial(requestId, acceptedHunks);
  }

  close(sessionId: string): boolean {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    r.close();
    this.runners.delete(sessionId);
    return true;
  }

  closeAll(): void {
    for (const r of this.runners.values()) r.close();
    this.runners.clear();
  }

  private emit(channel: string, payload: unknown): void {
    this.sender?.(channel, payload);
  }
}

export const sessions = new SessionsManager();

import type { WebContents } from 'electron';
import { ClaudeSpawnFailedError, type StartOptions, type PermissionMode, type AgentMessage } from './sessions';
import { ClaudeNotFoundError } from './binary-resolver';
import type { StartResult } from './start-result-types';
import { createRunner, type Runner } from '../agent-sdk/runner-factory';

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

class SessionsManager {
  private runners = new Map<string, Runner>();
  private sender: Sender | null = null;

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

  async start(sessionId: string, opts: StartOptions): Promise<StartResult> {
    if (this.runners.has(sessionId)) return { ok: true };
    try {
      const runner = createRunner(
        sessionId,
        (msg: AgentMessage) => this.emit('agent:event', { sessionId, message: msg }),
        ({ error }) => {
          this.emit('agent:exit', { sessionId, error });
          this.runners.delete(sessionId);
        },
        (req) => this.emit('agent:permissionRequest', { sessionId, ...req }),
        (diag) =>
          this.emit('agent:diagnostic', {
            sessionId,
            level: diag.level,
            code: diag.code,
            message: diag.message,
          } satisfies AgentDiagnostic)
      );
      await runner.start(opts);
      this.runners.set(sessionId, runner);
      return { ok: true };
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        return {
          ok: false,
          error: err.message,
          errorCode: 'CLAUDE_NOT_FOUND',
          searchedPaths: err.searchedPaths,
        };
      }
      if (err instanceof ClaudeSpawnFailedError) {
        return {
          ok: false,
          error: err.message,
          errorCode: 'CLI_SPAWN_FAILED',
          detail: err.detail,
        };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

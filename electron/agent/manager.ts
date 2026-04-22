import type { WebContents } from 'electron';
import { SessionRunner, type StartOptions, type PermissionMode, type AgentMessage } from './sessions';
import { ClaudeNotFoundError } from './binary-resolver';

type Sender = (channel: string, payload: unknown) => void;

export type StartResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      errorCode?: 'CLAUDE_NOT_FOUND' | 'CWD_MISSING';
      searchedPaths?: string[];
    };

class SessionsManager {
  private runners = new Map<string, SessionRunner>();
  private sender: Sender | null = null;

  bindSender(wc: WebContents): void {
    this.sender = (channel, payload) => {
      if (wc.isDestroyed()) return;
      wc.send(channel, payload);
    };
  }

  async start(sessionId: string, opts: StartOptions): Promise<StartResult> {
    if (this.runners.has(sessionId)) return { ok: true };
    try {
      const runner = new SessionRunner(
        sessionId,
        (msg: AgentMessage) => this.emit('agent:event', { sessionId, message: msg }),
        ({ error }) => {
          this.emit('agent:exit', { sessionId, error });
          this.runners.delete(sessionId);
        },
        (req) => this.emit('agent:permissionRequest', { sessionId, ...req })
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

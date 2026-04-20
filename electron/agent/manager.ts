import type { WebContents } from 'electron';
import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionRunner, type StartOptions } from './sessions';

type Sender = (channel: string, payload: unknown) => void;

class SessionsManager {
  private runners = new Map<string, SessionRunner>();
  private sender: Sender | null = null;

  bindSender(wc: WebContents): void {
    this.sender = (channel, payload) => {
      if (wc.isDestroyed()) return;
      wc.send(channel, payload);
    };
  }

  async start(sessionId: string, opts: StartOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.runners.has(sessionId)) return { ok: true };
    try {
      const runner = new SessionRunner(
        sessionId,
        (msg: SDKMessage) => this.emit('agent:event', { sessionId, message: msg }),
        ({ error }) => {
          this.emit('agent:exit', { sessionId, error });
          this.runners.delete(sessionId);
        }
      );
      await runner.start(opts);
      this.runners.set(sessionId, runner);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  send(sessionId: string, text: string): boolean {
    const r = this.runners.get(sessionId);
    if (!r) return false;
    r.send(text);
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

import type { CanUseTool, Options, PermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// SDK ships ESM-only (sdk.mjs). Electron main bundle is CJS, so a static
// `import { query }` triggers ERR_REQUIRE_ESM at load. Lazy-load via dynamic
// import on first start() and cache the module reference.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<SdkModule> | null = null;
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

export type StartOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  apiKey?: string;
  resumeSessionId?: string;
};

export type EventHandler = (msg: SDKMessage) => void;
export type ExitHandler = (info: { error?: string }) => void;
export type PermissionRequestHandler = (req: {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => void;

// AsyncIterable queue: pushes messages into the streaming input of `query()`.
// `query()` consumes via for-await; we resolve a pending waiter when a new
// message arrives, or buffer if the consumer hasn't asked yet.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  end(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      }
    };
  }
}

export class SessionRunner {
  private input = new InputQueue();
  private q: Query | null = null;
  private consumer: Promise<void> | null = null;
  private disposed = false;
  private pendingPerms = new Map<string, (r: PermissionResult) => void>();

  constructor(
    public readonly id: string,
    private readonly onEvent: EventHandler,
    private readonly onExit: ExitHandler,
    private readonly onPermissionRequest: PermissionRequestHandler
  ) {}

  resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean {
    const resolve = this.pendingPerms.get(requestId);
    if (!resolve) return false;
    this.pendingPerms.delete(requestId);
    resolve(
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: undefined }
        : { behavior: 'deny', message: 'User denied tool use.' }
    );
    return true;
  }

  async start(opts: StartOptions): Promise<void> {
    if (this.q) return;
    const env: Record<string, string | undefined> = { ...process.env };
    if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;

    const canUseTool: CanUseTool = (toolName, input) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this.pendingPerms.set(requestId, resolve);
        this.onPermissionRequest({ requestId, toolName, input });
      });

    const options: Options = {
      cwd: opts.cwd,
      env,
      permissionMode: opts.permissionMode ?? 'default',
      model: opts.model,
      resume: opts.resumeSessionId,
      canUseTool
    };

    const { query } = await loadSdk();
    this.q = query({ prompt: this.input, options });

    this.consumer = (async () => {
      try {
        for await (const msg of this.q!) {
          if (this.disposed) break;
          this.onEvent(msg);
        }
        this.onExit({});
      } catch (err) {
        this.onExit({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  send(text: string): void {
    if (!this.q || this.disposed) return;
    const msg: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: text }
    };
    this.input.push(msg);
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch {
      /* SDK throws if not in a tool call — ignore */
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.q) return;
    try {
      await this.q.setPermissionMode(mode);
    } catch {
      /* ignore */
    }
  }

  async setModel(model?: string): Promise<void> {
    if (!this.q) return;
    try {
      await this.q.setModel(model);
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of this.pendingPerms.values()) {
      resolve({ behavior: 'deny', message: 'Session closed.' });
    }
    this.pendingPerms.clear();
    this.input.end();
    try {
      this.q?.close();
    } catch {
      /* ignore */
    }
    this.q = null;
  }
}

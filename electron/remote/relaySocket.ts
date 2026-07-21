import WebSocket, { type RawData } from 'ws';

export type RelaySocketStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'unreachable'
  | 'closed';

export interface RelayWebSocket {
  readyState: number;
  on(event: 'open', handler: () => void): this;
  on(event: 'message', handler: (data: RawData) => void): this;
  on(event: 'pong', handler: () => void): this;
  on(event: 'error', handler: () => void): this;
  on(event: 'close', handler: () => void): this;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface RelaySocket {
  readonly url: string;
  connect(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (message: string) => void): () => void;
  onStatus(handler: (status: RelaySocketStatus) => void): () => void;
}

export type RelaySocketOptions = {
  relayUrl: string;
  roomId: string;
  createWebSocket?: (url: string) => RelayWebSocket;
  schedule?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
  random?: () => number;
  heartbeatMs?: number;
};

const OPEN = 1;
const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;

export function createRelaySocket(options: RelaySocketOptions): RelaySocket {
  const endpoint = new URL(`/relay/${options.roomId}`, options.relayUrl);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('role', 'desktop');
  const url = endpoint.toString();
  const createWebSocket =
    options.createWebSocket ?? ((target: string) => new WebSocket(target) as RelayWebSocket);
  const schedule = options.schedule ?? ((handler, delay) => setTimeout(handler, delay));
  const random = options.random ?? Math.random;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const messages = new Set<(message: string) => void>();
  const statuses = new Set<(status: RelaySocketStatus) => void>();
  let socket: RelayWebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectBase = INITIAL_RECONNECT_MS;
  let manuallyClosed = false;
  let alive = true;

  const emitStatus = (status: RelaySocketStatus): void => {
    for (const handler of statuses) handler(status);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const startHeartbeat = (current: RelayWebSocket): void => {
    stopHeartbeat();
    alive = true;
    heartbeatTimer = setInterval(() => {
      if (socket !== current) return;
      if (!alive) {
        current.terminate();
        return;
      }
      alive = false;
      current.ping();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  const open = (): void => {
    if (manuallyClosed || socket) return;
    emitStatus(reconnectBase === INITIAL_RECONNECT_MS ? 'connecting' : 'reconnecting');
    const current = createWebSocket(url);
    socket = current;

    current.on('open', () => {
      if (socket !== current) return;
      startHeartbeat(current);
      emitStatus('open');
    });
    current.on('message', (data) => {
      if (socket !== current) return;
      reconnectBase = INITIAL_RECONNECT_MS;
      alive = true;
      const raw = typeof data === 'string' ? data : data.toString();
      for (const handler of messages) handler(raw);
    });
    current.on('pong', () => {
      alive = true;
    });
    current.on('error', () => {
      if (socket === current && !manuallyClosed) emitStatus('unreachable');
    });
    current.on('close', () => {
      if (socket !== current) return;
      socket = null;
      stopHeartbeat();
      if (manuallyClosed) return;
      emitStatus('reconnecting');
      const delay = Math.round(reconnectBase * (0.5 + random() * 0.5));
      reconnectBase = Math.min(reconnectBase * 2, MAX_RECONNECT_MS);
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        open();
      }, Math.min(delay, MAX_RECONNECT_MS));
    });
  };

  return {
    url,
    connect() {
      if (manuallyClosed || socket || reconnectTimer) return;
      open();
    },
    send(message) {
      if (socket?.readyState === OPEN) socket.send(message);
    },
    close(code = 1000, reason = 'closed') {
      manuallyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopHeartbeat();
      if (socket) {
        const current = socket;
        socket = null;
        current.close(code, reason);
      }
      emitStatus('closed');
    },
    onMessage(handler) {
      messages.add(handler);
      return () => messages.delete(handler);
    },
    onStatus(handler) {
      statuses.add(handler);
      return () => statuses.delete(handler);
    },
  };
}

import { describe, expect, it, vi } from 'vitest';

import { createRelaySocket, type RelayWebSocket } from '../relaySocket';

class FakeSocket implements RelayWebSocket {
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  readyState = 0;
  ping = vi.fn();
  terminate = vi.fn();
  send = vi.fn();
  close = vi.fn();

  on(event: string, handler: (...args: never[]) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...(args as never[]));
  }
}

describe('relay socket transport', () => {
  it('reconnects with jittered exponential backoff capped at ten seconds', () => {
    const sockets: FakeSocket[] = [];
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    const relay = createRelaySocket({
      relayUrl: 'https://relay.example',
      roomId: 'B'.repeat(43),
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
      schedule: (handler, delay) => {
        delays.push(delay);
        scheduled.push(handler);
        return { handler } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    relay.connect();
    for (let index = 0; index < 8; index += 1) {
      sockets[index]!.emit('close');
      scheduled.shift()?.();
    }

    expect(delays).toEqual([375, 750, 1500, 3000, 6000, 7500, 7500, 7500]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(10_000);
    expect(new URL(relay.url).searchParams.get('role')).toBe('desktop');
    relay.close();
  });

  it('keeps backing off when sockets open but close before receiving peer traffic', () => {
    const sockets: FakeSocket[] = [];
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    const relay = createRelaySocket({
      relayUrl: 'https://relay.example',
      roomId: 'B'.repeat(43),
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
      schedule: (handler, delay) => {
        delays.push(delay);
        scheduled.push(handler);
        return { handler } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    relay.connect();
    for (let index = 0; index < 4; index += 1) {
      sockets[index]!.emit('open');
      sockets[index]!.emit('close');
      scheduled.shift()?.();
    }

    expect(delays).toEqual([375, 750, 1500, 3000]);
    relay.close();
  });

  it('terminates a socket that misses a heartbeat pong', () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const relay = createRelaySocket({
      relayUrl: 'https://relay.example',
      roomId: 'B'.repeat(43),
      createWebSocket: () => socket,
      heartbeatMs: 100,
    });

    relay.connect();
    socket.emit('open');
    vi.advanceTimersByTime(200);

    expect(socket.ping).toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalled();
    relay.close();
    vi.useRealTimers();
  });
});

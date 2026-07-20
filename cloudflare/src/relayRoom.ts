/* global DurableObjectState, Request, Response, TextEncoder, WebSocket, WebSocketPair */

import { DurableObject } from 'cloudflare:workers';

import type { RelayRole } from '../../src/shared/mobileRemote';
import {
  DESKTOP_ABSENT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_RELAY_FRAME_BYTES,
} from './limits';

export type RelayAttachment = {
  role: RelayRole;
  authenticated: boolean;
  connectedAt: number;
};

export type RelayRoomContext = DurableObjectState;

type RelayEnv = Record<string, never>;

export class RelayRoom extends DurableObject<RelayEnv> {
  constructor(ctx: RelayRoomContext, env: RelayEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role') as RelayRole;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    for (const old of this.ctx.getWebSockets(role)) {
      old.close(4001, 'replaced');
    }

    this.ctx.acceptWebSocket(server, [role]);
    const connectedAt = Date.now();
    server.serializeAttachment({
      role,
      authenticated: false,
      connectedAt,
    } satisfies RelayAttachment);
    await this.scheduleAlarm(connectedAt + HANDSHAKE_TIMEOUT_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const size =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > MAX_RELAY_FRAME_BYTES) {
      ws.close(1009, 'frame_too_large');
      return;
    }

    const attachment = ws.deserializeAttachment() as RelayAttachment;
    if (!attachment.authenticated && isAuthenticationFrame(message)) {
      ws.serializeAttachment({
        ...attachment,
        authenticated: true,
        connectedAt: Date.now(),
      } satisfies RelayAttachment);
    }

    const peerRole: RelayRole =
      attachment.role === 'desktop' ? 'phone' : 'desktop';
    for (const peer of this.ctx.getWebSockets(peerRole)) {
      peer.send(message);
    }
    await this.rescheduleCleanup();
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const { role } = ws.deserializeAttachment() as RelayAttachment;
    const peerRole: RelayRole = role === 'desktop' ? 'phone' : 'desktop';
    const peerCode = isSendableCloseCode(code) ? code : 1011;
    for (const peer of this.ctx.getWebSockets(peerRole)) {
      peer.close(peerCode, reason);
    }
    await this.rescheduleCleanup();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const { role } = ws.deserializeAttachment() as RelayAttachment;
    const peerRole: RelayRole = role === 'desktop' ? 'phone' : 'desktop';
    for (const peer of this.ctx.getWebSockets(peerRole)) {
      peer.close(1011, 'peer_error');
    }
    await this.rescheduleCleanup();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    const desktopPresent = sockets.some(
      (ws) =>
        (ws.deserializeAttachment() as RelayAttachment).role === 'desktop',
    );

    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as RelayAttachment;
      if (
        !attachment.authenticated &&
        now >= attachment.connectedAt + HANDSHAKE_TIMEOUT_MS
      ) {
        ws.close(4003, 'handshake_timeout');
      } else if (
        attachment.role === 'phone' &&
        !desktopPresent &&
        now >= attachment.connectedAt + DESKTOP_ABSENT_TIMEOUT_MS
      ) {
        ws.close(4004, 'desktop_absent');
      }
    }

    await this.rescheduleCleanup(now);
  }

  private async rescheduleCleanup(now = Date.now()): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const desktopPresent = sockets.some(
      (ws) =>
        (ws.deserializeAttachment() as RelayAttachment).role === 'desktop',
    );
    let nextDeadline: number | undefined;

    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as RelayAttachment;
      let deadline: number | undefined;
      if (!attachment.authenticated) {
        deadline = attachment.connectedAt + HANDSHAKE_TIMEOUT_MS;
      } else if (attachment.role === 'phone' && !desktopPresent) {
        deadline = attachment.connectedAt + DESKTOP_ABSENT_TIMEOUT_MS;
      }
      if (deadline !== undefined && deadline > now) {
        nextDeadline = Math.min(nextDeadline ?? deadline, deadline);
      }
    }

    if (nextDeadline === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.scheduleAlarm(nextDeadline);
    }
  }

  private async scheduleAlarm(deadline: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || deadline < current) {
      await this.ctx.storage.setAlarm(deadline);
    }
  }
}

function isSendableCloseCode(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

function isAuthenticationFrame(message: string | ArrayBuffer): boolean {
  if (typeof message !== 'string') return false;
  try {
    const value = JSON.parse(message) as { type?: unknown };
    return value.type === 'handshake.proof' || value.type === 'encrypted';
  } catch {
    return false;
  }
}

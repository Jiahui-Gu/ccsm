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
  connectionId: string;
  connectedAt: number;
  handshakeDeadline: number | null;
  hasForwardedFrame: boolean;
  authenticationConfirmed: boolean;
  authenticatedPeerConnectionId: string | null;
};

export type RelayRoomContext = DurableObjectState;

type RelayEnv = Record<string, never>;

export class RelayRoom extends DurableObject<RelayEnv> {
  constructor(ctx: RelayRoomContext, env: RelayEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role') as RelayRole;
    const occupants = this.ctx.getWebSockets(role);
    if (occupants.length > 0) {
      const now = Date.now();
      for (const occupant of occupants) {
        const attachment = this.attachmentFor(occupant);
        if (
          attachment.handshakeDeadline !== null &&
          now >= attachment.handshakeDeadline
        ) {
          occupant.close(4003, 'handshake_timeout');
        }
      }
      return new Response('Role already connected', { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [role]);
    const connectedAt = Date.now();
    server.serializeAttachment({
      role,
      connectionId: crypto.randomUUID(),
      connectedAt,
      handshakeDeadline: connectedAt + HANDSHAKE_TIMEOUT_MS,
      hasForwardedFrame: false,
      authenticationConfirmed: false,
      authenticatedPeerConnectionId: null,
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

    let attachment = this.attachmentFor(ws);
    if (
      attachment.handshakeDeadline !== null &&
      Date.now() >= attachment.handshakeDeadline
    ) {
      ws.close(4003, 'handshake_timeout');
      return;
    }
    if (isAuthenticationConfirmation(message)) {
      const peerRole: RelayRole =
        attachment.role === 'desktop' ? 'phone' : 'desktop';
      const peers = this.ctx.getWebSockets(peerRole);
      const peer =
        peers.length === 1
          ? peers[0]
          : undefined;
      attachment = {
        ...attachment,
        authenticationConfirmed: true,
        authenticatedPeerConnectionId: peer
          ? this.attachmentFor(peer).connectionId
          : null,
      };
      ws.serializeAttachment(attachment);
      const peerAttachment = peer
        ? this.attachmentFor(peer)
        : null;
      if (
        peer &&
        peerAttachment?.authenticationConfirmed &&
        attachment.authenticatedPeerConnectionId === peerAttachment.connectionId &&
        peerAttachment.authenticatedPeerConnectionId === attachment.connectionId
      ) {
        attachment = { ...attachment, handshakeDeadline: null };
        ws.serializeAttachment(attachment);
        peer.serializeAttachment({
          ...peerAttachment,
          handshakeDeadline: null,
        } satisfies RelayAttachment);
      } else if (
        peer &&
        peerAttachment?.authenticationConfirmed &&
        peerAttachment.handshakeDeadline === null
      ) {
        peer.serializeAttachment({
          ...peerAttachment,
          handshakeDeadline:
            attachment.handshakeDeadline ?? Date.now() + HANDSHAKE_TIMEOUT_MS,
        } satisfies RelayAttachment);
      }
      await this.rescheduleCleanup();
      return;
    }
    if (!attachment.hasForwardedFrame) {
      attachment = {
        ...attachment,
        hasForwardedFrame: true,
      };
      ws.serializeAttachment(attachment);
    }

    const peerRole: RelayRole =
      attachment.role === 'desktop' ? 'phone' : 'desktop';
    const peers = this.ctx.getWebSockets(peerRole);
    for (const peer of peers) {
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
    const attachment = this.attachmentFor(ws);
    if (this.hasRoleSuccessor(ws, attachment)) {
      await this.rescheduleCleanup();
      return;
    }
    const { role } = attachment;
    const peerRole: RelayRole = role === 'desktop' ? 'phone' : 'desktop';
    const peerCode = isSendableCloseCode(code) ? code : 1011;
    for (const peer of this.ctx.getWebSockets(peerRole)) {
      peer.close(peerCode, reason);
    }
    await this.rescheduleCleanup();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = this.attachmentFor(ws);
    if (this.hasRoleSuccessor(ws, attachment)) {
      await this.rescheduleCleanup();
      return;
    }
    const { role } = attachment;
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
      (ws) => this.attachmentFor(ws).role === 'desktop',
    );

    for (const ws of sockets) {
      const attachment = this.attachmentFor(ws);
      if (
        attachment.handshakeDeadline !== null &&
        now >= attachment.handshakeDeadline
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
      (ws) => this.attachmentFor(ws).role === 'desktop',
    );
    let nextDeadline: number | undefined;

    for (const ws of sockets) {
      const attachment = this.attachmentFor(ws);
      if (
        attachment.handshakeDeadline !== null &&
        now >= attachment.handshakeDeadline
      ) {
        ws.close(4003, 'handshake_timeout');
        continue;
      }
      let deadline: number | undefined;
      if (attachment.handshakeDeadline !== null) {
        deadline = attachment.handshakeDeadline;
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

  private hasRoleSuccessor(
    ws: WebSocket,
    attachment: RelayAttachment,
  ): boolean {
    return this.ctx.getWebSockets(attachment.role).some((candidate) => {
      if (candidate === ws) return false;
      const candidateAttachment = this.attachmentFor(candidate);
      return candidateAttachment.connectionId !== attachment.connectionId;
    });
  }

  private attachmentFor(ws: WebSocket): RelayAttachment {
    const stored = ws.deserializeAttachment() as Partial<RelayAttachment> &
      Pick<RelayAttachment, 'connectedAt' | 'role'>;
    if (
      typeof stored.connectionId === 'string' &&
      typeof stored.hasForwardedFrame === 'boolean' &&
      typeof stored.authenticationConfirmed === 'boolean' &&
      (stored.authenticatedPeerConnectionId === null ||
        typeof stored.authenticatedPeerConnectionId === 'string') &&
      (stored.handshakeDeadline === null ||
        typeof stored.handshakeDeadline === 'number')
    ) {
      return stored as RelayAttachment;
    }

    const attachment: RelayAttachment = {
      role: stored.role,
      connectionId: crypto.randomUUID(),
      connectedAt: stored.connectedAt,
      handshakeDeadline: stored.connectedAt + HANDSHAKE_TIMEOUT_MS,
      hasForwardedFrame: false,
      authenticationConfirmed: false,
      authenticatedPeerConnectionId: null,
    };
    ws.serializeAttachment(attachment);
    return attachment;
  }
}

function isSendableCloseCode(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

function isAuthenticationConfirmation(message: string | ArrayBuffer): boolean {
  if (typeof message !== 'string') return false;
  try {
    const value = JSON.parse(message) as { type?: unknown };
    return value.type === 'relay.authenticated';
  } catch {
    return false;
  }
}

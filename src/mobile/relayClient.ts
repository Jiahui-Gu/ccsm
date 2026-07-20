/* global MessageEvent, TextDecoder, TextEncoder, WebSocket */

import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  createHandshakeProof,
  deriveSessionKeys,
  openEnvelope,
  sealEnvelope,
  type EncryptedEnvelope,
  type HandshakeHello,
  type HandshakeProof,
  type PairingIdentity,
  type RandomValues,
  type SessionKeys,
} from '../shared/mobileRemote';
import type { MobileClientMessage, MobileServerMessage } from './phoneApp';

export type PhoneConnectionStatus =
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'update_required'
  | 'authentication_failed'
  | 'connection_error'
  | 'closed';

export type RelayClient = {
  connect(): void;
  send(message: MobileClientMessage): Promise<void>;
  close(): void;
  onMessage(handler: (message: MobileServerMessage) => void): () => void;
  onStatus(handler: (status: PhoneConnectionStatus) => void): () => void;
};

type SocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type PendingMessage = {
  message: MobileClientMessage;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
};

type RecoveryMessage = Extract<
  MobileClientMessage,
  { type: 'sessions.list' | 'session.snapshot' | 'session.resize' }
>;

export type RelayClientOptions = {
  relayUrl: string;
  pairing: PairingIdentity;
  createWebSocket?: (url: string) => SocketLike;
  randomValues?: RandomValues;
  schedule?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
  seal?: typeof sealEnvelope;
  heartbeatIntervalMs?: number;
  inactivityTimeoutMs?: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const OPEN = 1;
const MAX_PENDING_RECOVERY_REQUESTS = 32;

function defaultRandomValues(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHello(value: unknown): value is HandshakeHello {
  return (
    isRecord(value) &&
    value.type === 'handshake.hello' &&
    typeof value.version === 'number' &&
    (value.role === 'desktop' || value.role === 'phone') &&
    typeof value.connectionId === 'string' &&
    typeof value.nonce === 'string'
  );
}

function isProof(value: unknown): value is HandshakeProof {
  return (
    isRecord(value) &&
    value.type === 'handshake.proof' &&
    typeof value.connectionId === 'string' &&
    typeof value.proof === 'string'
  );
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    isRecord(value) &&
    value.type === 'encrypted' &&
    typeof value.version === 'number' &&
    typeof value.connectionId === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.ciphertext === 'string'
  );
}

export function handshakeTranscript(
  desktop: HandshakeHello,
  phone: HandshakeHello,
  provingRole: 'desktop' | 'phone',
): string {
  return JSON.stringify([
    'ccsm-mobile-remote-handshake',
    MOBILE_REMOTE_PROTOCOL_VERSION,
    desktop.connectionId,
    desktop.nonce,
    phone.nonce,
    provingRole,
  ]);
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const createSocket =
    options.createWebSocket ?? ((url: string): SocketLike => new WebSocket(url) as SocketLike);
  const randomValues = options.randomValues ?? defaultRandomValues;
  const schedule = options.schedule ?? ((handler, delay) => setTimeout(handler, delay));
  const seal = options.seal ?? sealEnvelope;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 45_000;
  const messageHandlers = new Set<(message: MobileServerMessage) => void>();
  const statusHandlers = new Set<(status: PhoneConnectionStatus) => void>();
  const suppressedSockets = new WeakSet<object>();
  const pendingMessages: PendingMessage[] = [];
  let socket: SocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 500;
  let manuallyClosed = false;
  let keys: SessionKeys | null = null;
  let peerVerified = false;
  let phoneHello: HandshakeHello | null = null;
  let desktopHello: HandshakeHello | null = null;
  let flushChain = Promise.resolve();
  let generation = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  function emitStatus(status: PhoneConnectionStatus): void {
    for (const handler of statusHandlers) handler(status);
  }

  function suppressAndClose(current: SocketLike, code: number, reason: string): void {
    suppressedSockets.add(current as object);
    current.close(code, reason);
  }

  function isRecoveryMessage(
    message: MobileClientMessage,
  ): message is RecoveryMessage {
    return (
      message.type === 'sessions.list' ||
      message.type === 'session.snapshot' ||
      message.type === 'session.resize'
    );
  }

  function recoveryKey(message: RecoveryMessage): string {
    return message.type === 'sessions.list' ? message.type : `${message.type}:${message.sid}`;
  }

  function settlePending(pending: PendingMessage, error?: unknown): void {
    for (const waiter of pending.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  function rejectUnsafePending(): void {
    for (let index = pendingMessages.length - 1; index >= 0; index -= 1) {
      const pending = pendingMessages[index]!;
      if (isRecoveryMessage(pending.message)) continue;
      pendingMessages.splice(index, 1);
      settlePending(pending, new Error('connection_changed'));
    }
  }

  function queueRecovery(pending: PendingMessage, front = false): boolean {
    const message = pending.message;
    if (!isRecoveryMessage(message)) return false;
    const key = recoveryKey(message);
    const duplicate = pendingMessages.find(
      (queued) => isRecoveryMessage(queued.message) && recoveryKey(queued.message) === key,
    );
    if (duplicate) {
      if (!front) duplicate.message = message;
      duplicate.waiters.push(...pending.waiters);
      return true;
    }
    const recoveryCount = pendingMessages.filter((queued) =>
      isRecoveryMessage(queued.message),
    ).length;
    if (recoveryCount >= MAX_PENDING_RECOVERY_REQUESTS) return false;
    if (front) pendingMessages.unshift(pending);
    else pendingMessages.push(pending);
    return true;
  }

  function clearConnectionTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    heartbeatTimer = null;
    inactivityTimer = null;
  }

  function armInactivityTimeout(current: SocketLike, currentGeneration: number): void {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (socket === current && generation === currentGeneration) {
        current.close(4000, 'inactivity_timeout');
      }
    }, inactivityTimeoutMs);
  }

  function startHeartbeat(current: SocketLike, currentGeneration: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (
        socket !== current ||
        generation !== currentGeneration ||
        current.readyState !== OPEN ||
        !peerVerified
      ) {
        return;
      }
      queueRecovery({
        message: { type: 'sessions.list' },
        waiters: [{ resolve: () => undefined, reject: () => undefined }],
      });
      void scheduleFlush();
    }, heartbeatIntervalMs);
  }

  async function flushPending(): Promise<void> {
    while (pendingMessages.length > 0) {
      if (!socket || socket.readyState !== OPEN || !peerVerified || !keys) return;
      const pending = pendingMessages.shift()!;
      const current: SocketLike = socket;
      const currentGeneration = generation;
      const currentKeys: SessionKeys = keys;
      try {
        const envelope = await seal(
          currentKeys.send,
          textEncoder.encode(JSON.stringify(pending.message)),
        );
        if (
          socket !== current ||
          generation !== currentGeneration ||
          current.readyState !== OPEN ||
          !peerVerified ||
          keys !== currentKeys
        ) {
          if (manuallyClosed) {
            settlePending(pending, new Error('client_closed'));
            continue;
          }
          if (isRecoveryMessage(pending.message) && queueRecovery(pending, true)) continue;
          settlePending(pending, new Error('connection_changed'));
          continue;
        }
        current.send(JSON.stringify(envelope));
        settlePending(pending);
      } catch (error) {
        settlePending(pending, error);
      }
    }
  }

  function scheduleFlush(): Promise<void> {
    flushChain = flushChain.then(flushPending);
    return flushChain;
  }

  async function handleMessage(
    current: SocketLike,
    currentGeneration: number,
    data: string,
  ): Promise<void> {
    const isCurrent = (): boolean => socket === current && generation === currentGeneration;
    if (!isCurrent()) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      emitStatus('authentication_failed');
      suppressAndClose(current, 4003, 'invalid_message');
      return;
    }

    if (isHello(message)) {
      if (message.version !== MOBILE_REMOTE_PROTOCOL_VERSION) {
        emitStatus('update_required');
        suppressAndClose(current, 4002, 'update_required');
        return;
      }
      if (
        message.role !== 'desktop' ||
        message.connectionId !== options.pairing.roomId ||
        !phoneHello
      ) {
        emitStatus('authentication_failed');
        suppressAndClose(current, 4003, 'invalid_hello');
        return;
      }
      if (desktopHello?.nonce === message.nonce && keys) return;
      const currentPhoneHello = phoneHello;
      const derivedKeys = await deriveSessionKeys({
        ...options.pairing,
        desktopNonce: message.nonce,
        phoneNonce: currentPhoneHello.nonce,
        role: 'phone',
      });
      if (!isCurrent()) return;
      desktopHello = message;
      keys = derivedKeys;
      const proof = await createHandshakeProof(
        options.pairing.secret,
        handshakeTranscript(message, currentPhoneHello, 'phone'),
      );
      if (isCurrent() && current.readyState === OPEN) {
        // Either role can reach the relay first, and frames are not buffered
        // while its peer is absent. Re-advertise our hello once the desktop is
        // known to be present so reconnect ordering cannot strand the handshake.
        current.send(JSON.stringify(phoneHello));
        current.send(
          JSON.stringify({
            type: 'handshake.proof',
            connectionId: options.pairing.roomId,
            proof,
          } satisfies HandshakeProof),
        );
      }
      return;
    }

    if (isProof(message)) {
      if (
        !desktopHello ||
        !phoneHello ||
        !keys ||
        message.connectionId !== options.pairing.roomId
      ) {
        emitStatus('authentication_failed');
        suppressAndClose(current, 4003, 'unexpected_proof');
        return;
      }
      const expected = await createHandshakeProof(
        options.pairing.secret,
        handshakeTranscript(desktopHello, phoneHello, 'desktop'),
      );
      if (!isCurrent()) return;
      if (message.proof !== expected) {
        emitStatus('authentication_failed');
        suppressAndClose(current, 4003, 'invalid_proof');
        return;
      }
      peerVerified = true;
      reconnectDelay = 500;
      current.send(JSON.stringify({ type: 'relay.authenticated' }));
      emitStatus('connected');
      startHeartbeat(current, currentGeneration);
      await scheduleFlush();
      return;
    }

    if (isEnvelope(message)) {
      if (!peerVerified || !keys) {
        emitStatus('authentication_failed');
        suppressAndClose(current, 4003, 'proof_required');
        return;
      }
      try {
        const currentKeys = keys;
        const plaintext = await openEnvelope(currentKeys.receive, message);
        if (!isCurrent() || keys !== currentKeys) return;
        const applicationMessage = JSON.parse(textDecoder.decode(plaintext)) as MobileServerMessage;
        for (const handler of messageHandlers) handler(applicationMessage);
      } catch {
        emitStatus('authentication_failed');
        suppressAndClose(current, 4003, 'invalid_frame');
      }
    }
  }

  function openConnection(): void {
    if (manuallyClosed) return;
    keys = null;
    peerVerified = false;
    desktopHello = null;
    const endpoint = new URL(`/relay/${options.pairing.roomId}`, options.relayUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.searchParams.set('role', 'phone');
    const current = createSocket(endpoint.toString());
    generation += 1;
    const currentGeneration = generation;
    let incomingMessages = Promise.resolve();
    socket = current;
    emitStatus(reconnectDelay === 500 ? 'connecting' : 'reconnecting');

    current.onopen = () => {
      if (socket !== current || generation !== currentGeneration) return;
      phoneHello = {
        type: 'handshake.hello',
        version: MOBILE_REMOTE_PROTOCOL_VERSION,
        role: 'phone',
        connectionId: options.pairing.roomId,
        nonce: encodeBase64Url(randomValues(new Uint8Array(16))),
      };
      emitStatus('authenticating');
      current.send(JSON.stringify(phoneHello));
      armInactivityTimeout(current, currentGeneration);
    };
    current.onmessage = (event) => {
      if (socket !== current || generation !== currentGeneration) return;
      armInactivityTimeout(current, currentGeneration);
      incomingMessages = incomingMessages
        .then(() => handleMessage(current, currentGeneration, event.data))
        .catch(() => {
          if (socket !== current || generation !== currentGeneration) return;
          emitStatus('authentication_failed');
          suppressAndClose(current, 4003, 'invalid_message');
        });
    };
    current.onerror = () => {
      if (socket !== current || generation !== currentGeneration) return;
      emitStatus('connection_error');
    };
    current.onclose = () => {
      if (socket !== current || generation !== currentGeneration) return;
      socket = null;
      generation += 1;
      keys = null;
      peerVerified = false;
      clearConnectionTimers();
      rejectUnsafePending();
      if (manuallyClosed || suppressedSockets.has(current as object)) return;
      emitStatus('reconnecting');
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        openConnection();
      }, delay);
    };
  }

  return {
    connect() {
      if (socket || reconnectTimer || manuallyClosed) return;
      openConnection();
    },
    send(message) {
      return new Promise<void>((resolve, reject) => {
        const pending = { message, waiters: [{ resolve, reject }] };
        if (isRecoveryMessage(message)) {
          if (!queueRecovery(pending)) reject(new Error('offline_queue_full'));
        } else if (!socket || socket.readyState !== OPEN || !peerVerified || !keys) {
          reject(new Error('not_authenticated'));
          return;
        } else {
          pendingMessages.push(pending);
        }
        void scheduleFlush();
      });
    },
    close() {
      manuallyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      generation += 1;
      clearConnectionTimers();
      for (const pending of pendingMessages.splice(0)) {
        settlePending(pending, new Error('client_closed'));
      }
      if (socket) {
        suppressedSockets.add(socket as object);
        socket.close(1000, 'client_closed');
        socket = null;
      }
      emitStatus('closed');
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
  };
}

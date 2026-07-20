/* global CryptoKey, SubtleCrypto, TextEncoder */

import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  type EncryptedEnvelope,
  type PairingIdentity,
  type RelayRole,
} from './protocol';

const textEncoder = new TextEncoder();
const ByteArray = textEncoder.encode('').constructor as typeof Uint8Array;
const PAIRING_VALUE_BYTES = 32;

type ChannelDirection = 'desktop-to-phone' | 'phone-to-desktop';
export type RandomValues = (bytes: Uint8Array) => Uint8Array;

export type SendChannelState = {
  key: CryptoKey;
  ivPrefix: Uint8Array;
  connectionId: string;
  direction: ChannelDirection;
  sequence: number;
};

export type ReceiveChannelState = {
  key: CryptoKey;
  ivPrefix: Uint8Array;
  connectionId: string;
  direction: ChannelDirection;
  lastSequence: number;
};

export type SessionKeys = {
  send: SendChannelState;
  receive: ReceiveChannelState;
};

export type DeriveSessionKeysOptions = {
  secret: string;
  roomId: string;
  desktopNonce: string;
  phoneNonce: string;
  role: RelayRole;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error('invalid_base64url');
  }

  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function webCryptoSubtle(subtle?: SubtleCrypto): SubtleCrypto {
  const resolved = subtle ?? globalThis.crypto?.subtle;
  if (!resolved) throw new Error('web_crypto_unavailable');
  return resolved;
}

function defaultRandomValues(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

export function generatePairingIdentity(
  randomValues: RandomValues = defaultRandomValues,
): PairingIdentity {
  return {
    roomId: encodeBase64Url(randomValues(new Uint8Array(PAIRING_VALUE_BYTES))),
    secret: encodeBase64Url(randomValues(new Uint8Array(PAIRING_VALUE_BYTES))),
  };
}

export async function createHandshakeProof(
  secret: string,
  transcript: string,
  subtle?: SubtleCrypto,
): Promise<string> {
  const cryptoSubtle = webCryptoSubtle(subtle);
  const key = await cryptoSubtle.importKey(
    'raw',
    webCryptoBytes(decodeBase64Url(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = await cryptoSubtle.sign(
    'HMAC',
    key,
    webCryptoBytes(textEncoder.encode(transcript)),
  );
  return encodeBase64Url(new Uint8Array(proof));
}

async function deriveDirection(
  options: DeriveSessionKeysOptions,
  direction: ChannelDirection,
  subtle: SubtleCrypto,
): Promise<{ key: CryptoKey; ivPrefix: Uint8Array }> {
  const sourceKey = await subtle.importKey(
    'raw',
    webCryptoBytes(decodeBase64Url(options.secret)),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const context = [
    'ccsm-mobile-remote',
    MOBILE_REMOTE_PROTOCOL_VERSION,
    options.desktopNonce,
    options.phoneNonce,
    direction,
  ].join('|');
  const material = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: webCryptoBytes(decodeBase64Url(options.roomId)),
        info: webCryptoBytes(textEncoder.encode(context)),
      },
      sourceKey,
      288,
    ),
  );
  const key = await subtle.importKey('raw', material.slice(0, 32), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { key, ivPrefix: material.slice(32, 36) };
}

export async function deriveSessionKeys(
  options: DeriveSessionKeysOptions,
  subtle?: SubtleCrypto,
): Promise<SessionKeys> {
  const cryptoSubtle = webCryptoSubtle(subtle);
  const desktopToPhone = await deriveDirection(options, 'desktop-to-phone', cryptoSubtle);
  const phoneToDesktop = await deriveDirection(options, 'phone-to-desktop', cryptoSubtle);
  const sendDirection =
    options.role === 'desktop' ? 'desktop-to-phone' : 'phone-to-desktop';
  const receiveDirection =
    options.role === 'desktop' ? 'phone-to-desktop' : 'desktop-to-phone';
  const sendMaterial = options.role === 'desktop' ? desktopToPhone : phoneToDesktop;
  const receiveMaterial = options.role === 'desktop' ? phoneToDesktop : desktopToPhone;

  return {
    send: {
      ...sendMaterial,
      connectionId: options.roomId,
      direction: sendDirection,
      sequence: 0,
    },
    receive: {
      ...receiveMaterial,
      connectionId: options.roomId,
      direction: receiveDirection,
      lastSequence: 0,
    },
  };
}

function encodeAdditionalData(
  connectionId: string,
  direction: ChannelDirection,
  sequence: number,
): Uint8Array<ArrayBuffer> {
  return webCryptoBytes(
    textEncoder.encode(
      JSON.stringify([
        connectionId,
        direction,
        MOBILE_REMOTE_PROTOCOL_VERSION,
        sequence,
      ]),
    ),
  );
}

function createIv(prefix: Uint8Array, sequence: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(new ArrayBuffer(12));
  iv.set(prefix, 0);
  new DataView(iv.buffer).setBigUint64(4, BigInt(sequence), false);
  return iv;
}

export async function sealEnvelope(
  state: SendChannelState,
  plaintext: Uint8Array,
  subtle?: SubtleCrypto,
): Promise<EncryptedEnvelope> {
  const sequence = state.sequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('invalid_sequence');

  const ciphertext = await webCryptoSubtle(subtle).encrypt(
    {
      name: 'AES-GCM',
      iv: createIv(state.ivPrefix, sequence),
      additionalData: encodeAdditionalData(state.connectionId, state.direction, sequence),
    },
    state.key,
    webCryptoBytes(plaintext),
  );
  state.sequence = sequence;

  return {
    type: 'encrypted',
    version: MOBILE_REMOTE_PROTOCOL_VERSION,
    connectionId: state.connectionId,
    sequence,
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openEnvelope(
  state: ReceiveChannelState,
  envelope: EncryptedEnvelope,
  subtle?: SubtleCrypto,
): Promise<Uint8Array> {
  if (
    envelope.type !== 'encrypted' ||
    envelope.version !== MOBILE_REMOTE_PROTOCOL_VERSION ||
    envelope.connectionId !== state.connectionId ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence <= 0
  ) {
    throw new Error('invalid_frame');
  }
  if (envelope.sequence <= state.lastSequence) throw new Error('replayed_frame');

  try {
    const plaintext = await webCryptoSubtle(subtle).decrypt(
      {
        name: 'AES-GCM',
        iv: createIv(state.ivPrefix, envelope.sequence),
        additionalData: encodeAdditionalData(
          envelope.connectionId,
          state.direction,
          envelope.sequence,
        ),
      },
      state.key,
      webCryptoBytes(decodeBase64Url(envelope.ciphertext)),
    );
    state.lastSequence = envelope.sequence;
    return new ByteArray(plaintext);
  } catch {
    throw new Error('invalid_frame');
  }
}

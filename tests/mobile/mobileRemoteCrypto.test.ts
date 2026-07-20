import {
  createHandshakeProof,
  deriveSessionKeys,
  generatePairingIdentity,
  openEnvelope,
  sealEnvelope,
} from '../../src/shared/mobileRemote';

const vector = {
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  roomId: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  desktopNonce: 'CCCCCCCCCCCCCCCCCCCCCC',
  phoneNonce: 'DDDDDDDDDDDDDDDDDDDDDD',
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('mobile remote cryptographic channel in a browser', () => {
  it('generates an injectable base64url pairing identity', () => {
    const randomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(7);
      return bytes;
    });

    expect(generatePairingIdentity(randomValues)).toEqual({
      roomId: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      secret: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    });
    expect(randomValues).toHaveBeenCalledTimes(2);
  });

  it('creates a stable HMAC handshake proof', async () => {
    await expect(createHandshakeProof(vector.secret, 'desktop|phone')).resolves.toBe(
      'IXzz3aJ4LvLoV2ACJLkQBIuf_eOTbQJ-22vjyDnIEvI',
    );
  });

  it('derives opposite directional keys and round-trips one envelope', async () => {
    const desktop = await deriveSessionKeys({ ...vector, role: 'desktop' });
    const phone = await deriveSessionKeys({ ...vector, role: 'phone' });
    const envelope = await sealEnvelope(desktop.send, utf8('{"type":"sessions.list"}'));

    await expect(openEnvelope(phone.receive, envelope)).resolves.toEqual(
      utf8('{"type":"sessions.list"}'),
    );
  });

  it('rejects replay and authenticated-data tampering', async () => {
    const desktop = await deriveSessionKeys({ ...vector, role: 'desktop' });
    const phone = await deriveSessionKeys({ ...vector, role: 'phone' });
    const envelope = await sealEnvelope(desktop.send, utf8('secret'));

    await openEnvelope(phone.receive, envelope);
    await expect(openEnvelope(phone.receive, envelope)).rejects.toThrow('replayed_frame');
    await expect(
      openEnvelope(phone.receive, { ...envelope, connectionId: 'tampered' }),
    ).rejects.toThrow('invalid_frame');
  });
});

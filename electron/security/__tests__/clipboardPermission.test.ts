import { describe, it, expect, vi } from 'vitest';
import {
  isClipboardPermissionAllowed,
  installClipboardPermissionHandlers,
  type ClipboardPermissionSession,
} from '../clipboardPermission';

describe('isClipboardPermissionAllowed', () => {
  it('grants clipboard-read for app:// origin', () => {
    expect(isClipboardPermissionAllowed('clipboard-read', 'app://ccsm')).toBe(
      true,
    );
    expect(
      isClipboardPermissionAllowed(
        'clipboard-read',
        'app://ccsm/listener-descriptor.json',
      ),
    ).toBe(true);
  });

  it('denies clipboard-read for any non-app origin', () => {
    expect(
      isClipboardPermissionAllowed('clipboard-read', 'http://localhost:4100'),
    ).toBe(false);
    expect(isClipboardPermissionAllowed('clipboard-read', 'file://')).toBe(
      false,
    );
    expect(
      isClipboardPermissionAllowed('clipboard-read', 'https://evil.example'),
    ).toBe(false);
  });

  it('denies any permission other than clipboard-read even from app://', () => {
    for (const perm of [
      'clipboard-write',
      'notifications',
      'geolocation',
      'media',
      'midi',
      'fullscreen',
    ]) {
      expect(isClipboardPermissionAllowed(perm, 'app://ccsm')).toBe(false);
    }
  });

  it('denies on malformed / empty requesting origin', () => {
    expect(isClipboardPermissionAllowed('clipboard-read', '')).toBe(false);
    expect(isClipboardPermissionAllowed('clipboard-read', 'not a url')).toBe(
      false,
    );
  });
});

describe('installClipboardPermissionHandlers', () => {
  function makeFakeSession(): {
    session: ClipboardPermissionSession;
    request: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
  } {
    const request = vi.fn();
    const check = vi.fn();
    return {
      session: {
        setPermissionRequestHandler: request,
        setPermissionCheckHandler: check,
      },
      request,
      check,
    };
  }

  it('registers a request handler that grants clipboard-read for app:// only', () => {
    const fake = makeFakeSession();
    installClipboardPermissionHandlers(fake.session);
    expect(fake.request).toHaveBeenCalledTimes(1);
    const handler = fake.request.mock.calls[0][0] as (
      wc: unknown,
      perm: string,
      cb: (granted: boolean) => void,
      details: { requestingUrl?: string },
    ) => void;

    const grants: boolean[] = [];
    handler({}, 'clipboard-read', (g) => grants.push(g), {
      requestingUrl: 'app://ccsm',
    });
    handler({}, 'clipboard-read', (g) => grants.push(g), {
      requestingUrl: 'http://localhost:4100',
    });
    handler({}, 'notifications', (g) => grants.push(g), {
      requestingUrl: 'app://ccsm',
    });
    handler({}, 'clipboard-read', (g) => grants.push(g), {});
    expect(grants).toEqual([true, false, false, false]);
  });

  it('registers a check handler that mirrors the request decider', () => {
    const fake = makeFakeSession();
    installClipboardPermissionHandlers(fake.session);
    expect(fake.check).toHaveBeenCalledTimes(1);
    const handler = fake.check.mock.calls[0][0] as (
      wc: unknown,
      perm: string,
      origin: string,
    ) => boolean;
    expect(handler({}, 'clipboard-read', 'app://ccsm')).toBe(true);
    expect(handler({}, 'clipboard-read', 'http://localhost:4100')).toBe(false);
    expect(handler({}, 'notifications', 'app://ccsm')).toBe(false);
  });
});

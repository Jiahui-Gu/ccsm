import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveHost,
  resolvePort,
  primaryLanIPv4,
  displayHost,
  parseRequestUrl,
  tokenMatches,
} from '../remote/remoteHttp';

// os.networkInterfaces can't be vi.spyOn'd under ESM (non-configurable export),
// so mock the module and swap the implementation per test via the handle.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});
const mockedNetworkInterfaces = os.networkInterfaces as unknown as ReturnType<typeof vi.fn>;

describe('resolvePort', () => {
  it('falls back to DEFAULT_PORT when unset', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
  });
  it('accepts a valid port', () => {
    expect(resolvePort('5000')).toBe(5000);
  });
  it('rejects out-of-range / non-integer values', () => {
    expect(resolvePort('0')).toBe(DEFAULT_PORT);
    expect(resolvePort('70000')).toBe(DEFAULT_PORT);
    expect(resolvePort('abc')).toBe(DEFAULT_PORT);
  });
});

describe('resolveHost', () => {
  it('defaults to loopback when unset', () => {
    expect(resolveHost(undefined)).toBe(DEFAULT_HOST);
    expect(resolveHost('')).toBe(DEFAULT_HOST);
    expect(resolveHost('   ')).toBe(DEFAULT_HOST);
  });
  it('accepts the loopback and all-interfaces sentinels', () => {
    expect(resolveHost('127.0.0.1')).toBe('127.0.0.1');
    expect(resolveHost('0.0.0.0')).toBe('0.0.0.0');
  });
  it('accepts a well-formed IPv4 literal', () => {
    expect(resolveHost('192.168.1.5')).toBe('192.168.1.5');
    expect(resolveHost('  10.0.0.2  ')).toBe('10.0.0.2');
  });
  it('falls back to loopback for an out-of-range octet', () => {
    expect(resolveHost('999.1.1.1')).toBe(DEFAULT_HOST);
    expect(resolveHost('192.168.1.256')).toBe(DEFAULT_HOST);
  });
  it('falls back to loopback for hostnames / garbage', () => {
    expect(resolveHost('example.com')).toBe(DEFAULT_HOST);
    expect(resolveHost('localhost')).toBe(DEFAULT_HOST);
    expect(resolveHost('not an ip')).toBe(DEFAULT_HOST);
  });
});

describe('primaryLanIPv4', () => {
  afterEach(() => mockedNetworkInterfaces.mockReset());

  it('returns the first non-internal IPv4', () => {
    mockedNetworkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
      eth0: [
        { address: '::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
        { address: '192.168.1.42', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
      ],
    });
    expect(primaryLanIPv4()).toBe('192.168.1.42');
  });

  it('returns null when only loopback exists', () => {
    mockedNetworkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
    });
    expect(primaryLanIPv4()).toBeNull();
  });
});

describe('displayHost', () => {
  afterEach(() => mockedNetworkInterfaces.mockReset());

  it('keeps loopback as loopback', () => {
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it('maps a non-loopback bind to the primary LAN IP', () => {
    mockedNetworkInterfaces.mockReturnValue({
      eth0: [
        { address: '10.1.2.3', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
      ],
    });
    expect(displayHost('0.0.0.0')).toBe('10.1.2.3');
  });

  it('falls back to the bind literal when no LAN IP exists', () => {
    mockedNetworkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
    });
    expect(displayHost('0.0.0.0')).toBe('0.0.0.0');
  });
});

describe('parseRequestUrl', () => {
  it('resolves a relative request-target to pathname + searchParams', () => {
    const url = parseRequestUrl('/?token=abc');
    expect(url?.pathname).toBe('/');
    expect(url?.searchParams.get('token')).toBe('abc');
  });
  it('parses the /ws path with a token', () => {
    const url = parseRequestUrl('/ws?token=xyz');
    expect(url?.pathname).toBe('/ws');
    expect(url?.searchParams.get('token')).toBe('xyz');
  });
  it('returns null for empty input', () => {
    expect(parseRequestUrl(undefined)).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('rejects null', () => {
    expect(tokenMatches(null, 'secret')).toBe(false);
  });
  it('rejects a different-length token', () => {
    expect(tokenMatches('short', 'a-much-longer-secret')).toBe(false);
  });
  it('rejects an equal-length mismatch', () => {
    expect(tokenMatches('AAAAA', 'BBBBB')).toBe(false);
  });
  it('accepts the exact token', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true);
  });
});

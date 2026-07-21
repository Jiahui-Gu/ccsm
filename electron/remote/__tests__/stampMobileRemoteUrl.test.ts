import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stampMobileRemoteUrl } from '../../../scripts/stamp-mobile-remote-url.mjs';

const fixtureDir = path.join(
  process.cwd(),
  'electron',
  'remote',
  '__tests__',
  '.stamp-mobile-remote-url-fixture',
);
const packagePath = path.join(fixtureDir, 'package.json');

describe('stampMobileRemoteUrl', () => {
  beforeEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
    await mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('stamps a canonical workers.dev HTTPS origin atomically', async () => {
    await writeFile(packagePath, '{\r\n    "name": "ccsm"\r\n}\r\n', 'utf8');

    await stampMobileRemoteUrl(
      packagePath,
      'https://ccsm-mobile-remote.owner.workers.dev/',
    );

    const stamped = await readFile(packagePath, 'utf8');
    expect(JSON.parse(stamped).mobileRemoteRelayUrl).toBe(
      'https://ccsm-mobile-remote.owner.workers.dev',
    );
    expect(stamped).toBe(
      '{\r\n    "name": "ccsm",\r\n    "mobileRemoteRelayUrl": "https://ccsm-mobile-remote.owner.workers.dev"\r\n}\r\n',
    );
    expect(await readdir(fixtureDir)).toEqual(['package.json']);
  });

  it.each([
    'http://ccsm-mobile-remote.owner.workers.dev',
    'https://example.com',
    'https://user@ccsm-mobile-remote.owner.workers.dev',
    'https://user:password@ccsm-mobile-remote.owner.workers.dev',
    'https://ccsm-mobile-remote.owner.workers.dev:443',
    'https://ccsm-mobile-remote.owner.workers.dev?token=secret',
    'https://ccsm-mobile-remote.owner.workers.dev#fragment',
    'https://workers.dev',
    'https://ccsm-mobile-remote.owner.workers.dev/path',
    'not a URL',
  ])('rejects invalid relay URL %s without changing the package', async (relayUrl) => {
    const original = '{\n  "name": "ccsm"\n}\n';
    await writeFile(packagePath, original, 'utf8');

    await expect(stampMobileRemoteUrl(packagePath, relayUrl)).rejects.toThrow(
      'invalid_relay_url',
    );

    expect(await readFile(packagePath, 'utf8')).toBe(original);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

type PackageMetadata = {
  mobileRemoteRelayUrl?: unknown;
};

export type RelayConfigOptions = {
  isPackaged?: boolean;
  packageMetadata?: PackageMetadata;
  env?: NodeJS.ProcessEnv;
};

function validPackagedRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname.endsWith('.workers.dev') ||
      parsed.hostname === 'workers.dev' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function validDevelopmentRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function readPackageMetadata(): PackageMetadata {
  try {
    const packagePath = path.join(app.getAppPath(), 'package.json');
    return JSON.parse(fs.readFileSync(packagePath, 'utf8')) as PackageMetadata;
  } catch {
    return {};
  }
}

export function resolveRelayUrl(options: RelayConfigOptions = {}): string | null {
  const packaged = options.isPackaged ?? app.isPackaged;
  const metadata = options.packageMetadata ?? readPackageMetadata();
  if (packaged) return validPackagedRelayUrl(metadata.mobileRemoteRelayUrl);
  return validDevelopmentRelayUrl(
    (options.env ?? process.env).CCSM_MOBILE_REMOTE_RELAY_URL,
  );
}

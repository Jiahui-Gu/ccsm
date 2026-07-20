import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseRelayOrigin(relayUrl) {
  let parsed;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error('invalid_relay_url');
  }

  const canonicalInputs = new Set([parsed.origin, `${parsed.origin}/`]);
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.workers.dev') ||
    parsed.hostname === 'workers.dev' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !canonicalInputs.has(relayUrl)
  ) {
    throw new Error('invalid_relay_url');
  }

  return parsed.origin;
}

function detectFormatting(source) {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const indent = source.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  const finalNewline = source.endsWith('\n');
  return { finalNewline, indent, lineEnding };
}

export async function stampMobileRemoteUrl(packagePath, relayUrl) {
  const relayOrigin = parseRelayOrigin(relayUrl);
  const source = await readFile(packagePath, 'utf8');
  const pkg = JSON.parse(source);
  const { finalNewline, indent, lineEnding } = detectFormatting(source);
  pkg.mobileRemoteRelayUrl = relayOrigin;

  let output = JSON.stringify(pkg, null, indent).replaceAll('\n', lineEnding);
  if (finalNewline) output += lineEnding;

  const packageStats = await stat(packagePath);
  const tempPath = path.join(
    path.dirname(packagePath),
    `.${path.basename(packagePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  let tempFile;
  try {
    tempFile = await open(tempPath, 'wx', packageStats.mode);
    await tempFile.writeFile(output, 'utf8');
    await tempFile.sync();
    await tempFile.close();
    tempFile = undefined;
    await rename(tempPath, packagePath);
  } finally {
    await tempFile?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

const isCliEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntry) {
  const [packagePath, relayUrl] = process.argv.slice(2);
  if (!packagePath || !relayUrl) {
    console.error('usage: stamp-mobile-remote-url <package.json> <relay-url>');
    process.exitCode = 1;
  } else {
    try {
      await stampMobileRemoteUrl(packagePath, relayUrl);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'stamp_failed');
      process.exitCode = 1;
    }
  }
}

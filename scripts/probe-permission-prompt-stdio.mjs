// Probe: the spawn pipeline tells claude.exe to delegate per-tool permission
// decisions over stdio.
//
// Why this exists: pre-fix, agentory removed the @anthropic-ai/claude-agent-sdk
// dependency but did not replicate the two SDK behaviours that turn on
// `can_use_tool` control_requests:
//
//   1. Pass `--permission-prompt-tool stdio` on the claude.exe command line.
//   2. Send an `initialize` control_request as the first frame on stdin.
//
// Without BOTH, the CLI silently falls back to its local rule engine and never
// emits a single `can_use_tool` request — so the renderer's perfectly good
// PermissionPromptBlock never had anything to render. This probe locks down
// both signals at the spawn / SessionRunner layer using mocks (no claude.exe
// needed) so any future refactor that drops the flag or skips the handshake
// fails loudly.
//
// Usage: node scripts/probe-permission-prompt-stdio.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-permission-prompt-stdio] FAIL: ${msg}`);
  process.exit(1);
}

// Run two focused tests via vitest. We use two separate invocations rather
// than a single regex/glob because Windows cmd.exe interprets `|` as a pipe
// before vitest sees it (and quoting the regex as a single argv string
// confuses vitest's CLI parser inconsistently across PowerShell/cmd/bash).
function runTest(testNameSubstring, file) {
  const r = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=basic', '-t', testNameSubstring, file],
    { cwd: root, stdio: 'inherit', shell: true }
  );
  if (r.status !== 0) fail(`vitest exited ${r.status} for ${file} :: ${testNameSubstring}`);
}

runTest(
  'permission-prompt-tool stdio',
  'electron/agent/__tests__/claude-spawner.test.ts'
);
runTest(
  'initialize control_request',
  'electron/agent/__tests__/sessions.test.ts'
);

console.log('\n[probe-permission-prompt-stdio] OK');
console.log('  - claude-spawner adds `--permission-prompt-tool stdio` to argv');
console.log('  - SessionRunner sends `initialize` control_request on start');
console.log('Together these make claude.exe emit `can_use_tool` for tools like Write/Edit,');
console.log('which the renderer turns into the existing PermissionPromptBlock.');

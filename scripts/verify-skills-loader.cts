// One-shot verification script for the commands-loader plugin-skill scan.
// Runs the loader against the user's real ~/.claude tree and prints the
// resulting entries grouped by source. Used as PR evidence — not a CI gate.
//
// Run: npx tsx scripts/verify-skills-loader.cts
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCommands } from '../electron/commands-loader';

const home = os.homedir();
const claudeRoot = path.join(home, '.claude');
const cmds = loadCommands({ homeDir: home, cwd: process.cwd() });

const bySource = new Map<string, string[]>();
for (const c of cmds) {
  if (!bySource.has(c.source)) bySource.set(c.source, []);
  bySource.get(c.source)!.push(c.name);
}

console.log(`# loader output for ${claudeRoot}`);
console.log(`total entries: ${cmds.length}`);
console.log('');
for (const [src, names] of bySource) {
  console.log(`## ${src} (${names.length})`);
  for (const n of names.sort()) console.log(`  - ${n}`);
  console.log('');
}

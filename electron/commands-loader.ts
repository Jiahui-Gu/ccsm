// Disk-based slash-command loader.
//
// Mirrors what claude.exe does internally: pull `*.md` command files from
// the user's Claude config tree so the GUI picker can offer them. CCSM
// only DISCOVERS — execution is always pass-through to claude.exe (the
// renderer types `/<name> <args>` and the CLI handles it).
//
// Conflict resolution order (lower priority number = wins):
//   0. <cwd>/.claude/commands/*.md                      (source: 'project')
//   1. ~/.claude/commands/*.md                          (source: 'user')
//   2. ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/*.md
//      (source: 'plugin', name namespaced as `<plugin>:<basename>`)
//   3. ~/.claude/skills/*.md                            (source: 'skill', tolerated if absent)
//   4. <cwd>/.claude/agents/*.md                        (source: 'agent', project-level, tolerated if absent)
//   5. ~/.claude/agents/*.md                            (source: 'agent', user-level, tolerated if absent)
//
// Project-level entries shadow user-level entries of the same name — this
// matches the upstream Claude CLI's behavior where a per-project override
// takes precedence over the user's global config. Lower-priority duplicates
// are dropped with a console.warn so the user can debug.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Six logical sources surfaced by the slash-command palette. `skill` and
// `agent` were previously folded into `user`; splitting them lets the picker
// show a six-section UI matching the official VS Code extension's grouping.
export type CommandSource = 'user' | 'project' | 'plugin' | 'skill' | 'agent';

export type LoadedCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: CommandSource;
  pluginId?: string;
};

type RawEntry = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: CommandSource;
  pluginId?: string;
  /** Filesystem path to the source `.md` — kept for log messages only. */
  file: string;
  /** Lower = higher priority. */
  priority: number;
};

// ────────────────────────── frontmatter parser ─────────────────────────────
//
// Tiny YAML-frontmatter reader. We only care about a couple of scalar string
// fields (`name`, `description`, `argument-hint`); anything else is ignored.
// Hand-rolling avoids pulling in `gray-matter` / `js-yaml` for what is
// effectively two regexes.
//
// Supports:
//   - Quoted values:  description: "Run the worker"
//   - Bare values:    name: foo-bar
//   - Lines starting with `#` are treated as YAML comments and skipped.
//
// Does NOT support nested objects, arrays, multi-line strings, or anchors —
// which is fine: every command frontmatter we've seen in the wild fits this.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { data: {}, body: raw };
  const yamlBlock = m[1];
  const body = raw.slice(m[0].length);
  const data: Record<string, string> = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Strip a single pair of matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    data[key] = value;
  }
  return { data, body };
}

// ────────────────────────── directory walking ──────────────────────────────

function isReadableDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listMdFiles(dir: string): string[] {
  if (!isReadableDir(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => path.join(dir, f));
  } catch (err) {
    console.warn(`[commands-loader] readdir failed for ${dir}:`, err);
    return [];
  }
}

function readEntry(
  file: string,
  source: CommandSource,
  priority: number,
  pluginId?: string
): RawEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`[commands-loader] read failed for ${file}:`, err);
    return null;
  }
  const { data } = parseFrontmatter(raw);
  const fallbackName = path.basename(file).replace(/\.md$/i, '');
  // Names containing `/` or whitespace are illegal at the slash-prompt; skip.
  if (!/^[a-zA-Z0-9._-]+$/.test(fallbackName)) {
    console.warn(`[commands-loader] skipping ${file}: basename has invalid chars`);
    return null;
  }
  const declaredName = (data['name'] || '').trim();
  const baseName = declaredName || fallbackName;
  if (!/^[a-zA-Z0-9._-]+$/.test(baseName)) {
    console.warn(
      `[commands-loader] skipping ${file}: name "${baseName}" has invalid chars`
    );
    return null;
  }
  const fullName = pluginId ? `${pluginId}:${baseName}` : baseName;
  return {
    name: fullName,
    description: data['description'] || undefined,
    argumentHint: data['argument-hint'] || undefined,
    source,
    pluginId,
    file,
    priority,
  };
}

// ────────────────────────── plugin discovery ───────────────────────────────
//
// `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/*.md`
// is the canonical layout (verified against this developer's box). We pick
// the lexicographically-largest version dir so a stale `4.x` left around
// next to `5.x` doesn't shadow current commands.

function pickHighestVersionDir(pluginDir: string): string | null {
  if (!isReadableDir(pluginDir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(pluginDir);
  } catch {
    return null;
  }
  const versionDirs = entries
    .filter((name) => isReadableDir(path.join(pluginDir, name)))
    .sort();
  const last = versionDirs[versionDirs.length - 1];
  return last ? path.join(pluginDir, last) : null;
}

function collectPluginEntries(pluginsRoot: string, basePriority: number): RawEntry[] {
  const cacheRoot = path.join(pluginsRoot, 'cache');
  if (!isReadableDir(cacheRoot)) return [];
  const out: RawEntry[] = [];
  let marketplaces: string[];
  try {
    marketplaces = fs.readdirSync(cacheRoot);
  } catch {
    return [];
  }
  for (const market of marketplaces) {
    const marketDir = path.join(cacheRoot, market);
    if (!isReadableDir(marketDir)) continue;
    let plugins: string[];
    try {
      plugins = fs.readdirSync(marketDir);
    } catch {
      continue;
    }
    for (const pluginId of plugins) {
      const pluginDir = path.join(marketDir, pluginId);
      const versionDir = pickHighestVersionDir(pluginDir);
      if (!versionDir) continue;
      const cmdDir = path.join(versionDir, 'commands');
      for (const file of listMdFiles(cmdDir)) {
        const entry = readEntry(file, 'plugin', basePriority, pluginId);
        if (entry) out.push(entry);
      }
    }
  }
  return out;
}

// ────────────────────────── public entry point ─────────────────────────────

export type LoadOpts = {
  /** Override `~` for tests. */
  homeDir?: string;
  /** Project cwd (typically the active session's cwd). */
  cwd?: string | null;
};

export function loadCommands(opts: LoadOpts = {}): LoadedCommand[] {
  const home = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? null;
  const claudeRoot = path.join(home, '.claude');
  const all: RawEntry[] = [];

  // 1. user (priority 1 — shadowed by project)
  for (const file of listMdFiles(path.join(claudeRoot, 'commands'))) {
    const e = readEntry(file, 'user', 1);
    if (e) all.push(e);
  }
  // 2. project (priority 0 — wins over user, matching upstream CLI)
  if (cwd && path.isAbsolute(cwd)) {
    for (const file of listMdFiles(path.join(cwd, '.claude', 'commands'))) {
      const e = readEntry(file, 'project', 0);
      if (e) all.push(e);
    }
  }
  // 3. plugins
  all.push(...collectPluginEntries(path.join(claudeRoot, 'plugins'), 2));
  // 4. skills (own bucket so the picker can render a "Skills" section)
  for (const file of listMdFiles(path.join(claudeRoot, 'skills'))) {
    const e = readEntry(file, 'skill', 3);
    if (e) all.push(e);
  }
  // 5. agents — user (priority 5) then project (priority 4) so the project
  //    agent shadows the user agent of the same name.
  for (const file of listMdFiles(path.join(claudeRoot, 'agents'))) {
    const e = readEntry(file, 'agent', 5);
    if (e) all.push(e);
  }
  if (cwd && path.isAbsolute(cwd)) {
    for (const file of listMdFiles(path.join(cwd, '.claude', 'agents'))) {
      const e = readEntry(file, 'agent', 4);
      if (e) all.push(e);
    }
  }

  // Conflict resolution: keep the lowest-priority entry per name, drop the
  // rest with a warning.
  const byName = new Map<string, RawEntry>();
  for (const entry of all) {
    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
      continue;
    }
    if (entry.priority < existing.priority) {
      console.warn(
        `[commands-loader] /${entry.name}: ${existing.file} shadowed by ${entry.file}`
      );
      byName.set(entry.name, entry);
    } else {
      console.warn(
        `[commands-loader] /${entry.name}: ${entry.file} shadowed by ${existing.file}`
      );
    }
  }

  // Stable order: user → project → plugin → skill → agent, then alphabetical.
  const sourceOrder: Record<CommandSource, number> = {
    user: 0,
    project: 1,
    plugin: 2,
    skill: 3,
    agent: 4,
  };
  return Array.from(byName.values())
    .sort((a, b) => {
      const so = sourceOrder[a.source] - sourceOrder[b.source];
      if (so !== 0) return so;
      return a.name.localeCompare(b.name);
    })
    .map((e) => ({
      name: e.name,
      description: e.description,
      argumentHint: e.argumentHint,
      source: e.source,
      ...(e.pluginId ? { pluginId: e.pluginId } : {}),
    }));
}

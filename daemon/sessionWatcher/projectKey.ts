// Encode an absolute cwd into the project-directory name used by
// `~/.claude/projects/<key>/<sid>.jsonl`.
//
// The Claude Code CLI replaces every path-separator-like character (`\`,
// `/`, `:`) in the cwd with `-`. Examples (Windows shapes seen in the wild,
// see `~/.claude/projects/`):
//
//   C:\Users\jiahuigu              → C--Users-jiahuigu
//   C:\Users\jiahuigu\ccsm-worktrees\pool-7
//                                  → C--Users-jiahuigu-ccsm-worktrees-pool-7
//
// We don't import this from claude-agent-sdk because the SDK doesn't
// surface this as a public helper — the encoding is a CLI-internal
// convention but it's been stable across every CLI release ccsm has shipped
// against. If the CLI ever changes it, our jsonl-existence probe in
// `electron/ptyHost/index.ts` (which scans every project dir for the sid)
// is the safety net: the watcher's path may be wrong but the user-facing
// pty path keeps working.
export function cwdToProjectKey(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  return cwd.replace(/[\\/:]/g, '-');
}

// Cross-boundary (renderer + main) agent identifier constants.
//
// These string literals are PERSISTED in SQLite (`sessions.agent_type`
// column) and stored in user prefs / serialized state. Once shipped,
// changing the wire value silently breaks existing user data — every
// row read from disk would no longer match.
//
// Phase 1 of the multi-agent refactor: extract the magic string into a
// named constant so future agents (codex/cursor/aider/...) can be added
// without grepping for `'claude-code'` literals scattered across the
// codebase, and so DB migrations can reference the same symbol the
// runtime uses to write.
//
// `tests/shared/agentIds.test.ts` pins the wire value — do not change it.
export const CLAUDE_CODE_AGENT_ID = 'claude-code' as const;

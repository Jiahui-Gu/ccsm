// Pin the persisted wire value of CLAUDE_CODE_AGENT_ID.
//
// The constant is written into the SQLite `sessions.agent_type` column
// and serialized into prefs / app state. Once shipped, changing the
// string silently breaks every existing user's data — rows on disk
// would no longer match the new symbol. This test exists to fail loudly
// in CI if anyone touches the literal value, including future DB
// migrations that should reference the constant rather than re-hardcode.

import { describe, it, expect } from 'vitest';
import { CLAUDE_CODE_AGENT_ID } from '../../src/shared/agentIds';

describe('CLAUDE_CODE_AGENT_ID', () => {
  it('matches the DB persistence wire value', () => {
    expect(CLAUDE_CODE_AGENT_ID).toBe('claude-code');
  });
});

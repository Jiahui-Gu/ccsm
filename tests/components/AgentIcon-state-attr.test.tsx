import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AgentIcon } from '../../src/components/AgentIcon';
import type { SessionState } from '../../src/types';

// Task #785: regression guard — AgentIcon must expose its current state via
// the `data-agent-icon-state` attribute so e2e selectors that target
// `[data-agent-icon-state="waiting"]` keep working. Silently dropping the
// attribute would break harness-agent probes without breaking unit tests.
describe('<AgentIcon /> data-agent-icon-state attribute (#785)', () => {
  afterEach(() => cleanup());

  // Mirrors the public union from src/types.ts — keep in sync if extended.
  const STATES: SessionState[] = ['idle', 'waiting'];

  for (const state of STATES) {
    it(`renders data-agent-icon-state="${state}"`, () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state={state} />
      );
      const el = container.querySelector(`[data-agent-icon-state]`);
      expect(el).toBeTruthy();
      expect(el!.getAttribute('data-agent-icon-state')).toBe(state);
    });
  }
});

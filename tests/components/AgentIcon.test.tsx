// UT for src/components/AgentIcon.tsx — extends the existing
// `AgentIcon-state-attr.test.tsx` (which only pins the data-state attribute)
// with the visual contract:
//   * agentType=claude-code renders the orange Claude asterisk svg
//   * other agentTypes render no inner glyph (defensive — current union has
//     a single value but the prop is forward-compat)
//   * size=sm/md control the wrapper width/height (16 / 20px)
//   * `flashing` flag is OR-ed with state==='waiting' to drive the halo
//     (we can't measure the halo visually here without animations, but the
//     branch is exercised end-to-end by snapshotting the data-state plus
//     verifying the component doesn't crash with flashing=true)
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AgentIcon } from '../../src/components/AgentIcon';
import type { AgentType, SessionState } from '../../src/types';

afterEach(() => cleanup());

describe('<AgentIcon /> visual contract', () => {
  it('claude-code agent renders the asterisk svg', () => {
    const { container } = render(
      <AgentIcon agentType="claude-code" state="idle" />
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('fill')).toBe('#D97757');
  });

  it('non-claude-code agentType renders no inner svg', () => {
    // Forward-compat: cast a synthetic agentType to exercise the `inner = null`
    // branch. If the AgentType union is ever narrowed back to claude-code only,
    // remove this case.
    const { container } = render(
      <AgentIcon
        agentType={'unknown-agent' as unknown as AgentType}
        state="idle"
      />
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it.each([
    ['sm', 16],
    ['md', 20],
  ] as const)('size=%s wrapper is %ipx square', (size, px) => {
    const { container } = render(
      <AgentIcon agentType="claude-code" state="idle" size={size} />
    );
    const wrapper = container.querySelector(
      '[data-agent-icon-state]'
    ) as HTMLElement;
    expect(wrapper.style.width).toBe(`${px}px`);
    expect(wrapper.style.height).toBe(`${px}px`);
  });

  it('default size is sm (16px)', () => {
    const { container } = render(
      <AgentIcon agentType="claude-code" state="idle" />
    );
    const wrapper = container.querySelector(
      '[data-agent-icon-state]'
    ) as HTMLElement;
    expect(wrapper.style.width).toBe('16px');
  });

  it('flashing=true does not crash and keeps the data-state attribute', () => {
    const { container } = render(
      <AgentIcon agentType="claude-code" state="idle" flashing />
    );
    const wrapper = container.querySelector('[data-agent-icon-state]')!;
    // The persistent state stays "idle" — flashing is a transient overlay
    // signal driven by the notify pipeline, not a state mutation.
    expect(wrapper.getAttribute('data-agent-icon-state')).toBe('idle');
  });

  it.each(['idle', 'waiting'] as SessionState[])(
    'state=%s round-trips through data-agent-icon-state',
    (state) => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state={state} />
      );
      expect(
        container
          .querySelector('[data-agent-icon-state]')!
          .getAttribute('data-agent-icon-state')
      ).toBe(state);
    }
  );

  // audit #876 cluster 2.3: explicit attention priority — crashed wins
  // over waiting/flashing. The `data-attention` attribute pins the
  // resolved bucket so we don't need to measure framer-motion output.
  describe('attention priority (audit #876 cluster 2.3)', () => {
    it('crashed=true + state=waiting → attention=crashed (halo suppressed)', () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state="waiting" crashed />
      );
      const wrapper = container.querySelector('[data-attention]')!;
      expect(wrapper.getAttribute('data-attention')).toBe('crashed');
    });

    it('crashed=true + flashing=true → attention=crashed (halo suppressed)', () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state="idle" crashed flashing />
      );
      const wrapper = container.querySelector('[data-attention]')!;
      expect(wrapper.getAttribute('data-attention')).toBe('crashed');
    });

    it('crashed=true + state=waiting + flashing=true → attention=crashed', () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state="waiting" crashed flashing />
      );
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('crashed');
    });

    it('state=waiting alone → attention=waiting-or-flashing', () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state="waiting" />
      );
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('waiting-or-flashing');
    });

    it('flashing=true alone (idle state) → attention=waiting-or-flashing', () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state="idle" flashing />
      );
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('waiting-or-flashing');
    });

    it('idle, no crashed, no flashing → attention=idle', () => {
      const { container } = render(
        <AgentIcon agentType="claude-code" state="idle" />
      );
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('idle');
    });
  });
});

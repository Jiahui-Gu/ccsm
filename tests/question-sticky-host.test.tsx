import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { QuestionStickyHost } from '../src/components/QuestionStickyHost';
import { useStore } from '../src/stores/store';
import type { MessageBlock } from '../src/types';

const initial = useStore.getState();

afterEach(() => cleanup());

const QSPEC = {
  question: 'Pick one',
  options: [{ label: 'A' }, { label: 'B' }]
};

function seedBlocks(blocks: MessageBlock[]) {
  useStore.setState(
    {
      ...initial,
      activeId: 's1',
      messagesBySession: { s1: blocks }
    },
    true
  );
}

const ccsmStub = {
  agentSend: vi.fn().mockResolvedValue(true),
  agentResolvePermission: vi.fn().mockResolvedValue(undefined),
  agentSendContent: vi.fn().mockResolvedValue(true),
  agentInterrupt: vi.fn().mockResolvedValue(undefined)
};

beforeEach(() => {
  ccsmStub.agentSend.mockClear();
  ccsmStub.agentResolvePermission.mockClear();
  (window as unknown as { ccsm?: typeof ccsmStub }).ccsm = ccsmStub;
});

async function flush(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('<QuestionStickyHost />', () => {
  it('renders nothing when no question block exists', () => {
    seedBlocks([{ kind: 'user', id: 'u1', text: 'hi' }]);
    const { container } = render(<QuestionStickyHost sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only the FIRST unanswered question block (cross-turn queue)', async () => {
    seedBlocks([
      { kind: 'question', id: 'q1', questions: [{ ...QSPEC, header: 'First' }] },
      { kind: 'question', id: 'q2', questions: [{ ...QSPEC, header: 'Second' }] }
    ]);
    render(<QuestionStickyHost sessionId="s1" />);
    await flush();
    // Only one nav bar (so only one card).
    expect(screen.getAllByTestId('question-nav-bar').length).toBe(1);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('on submit: marks block answered, advances queue, calls agentSend', async () => {
    seedBlocks([
      { kind: 'question', id: 'q1', questions: [{ ...QSPEC, header: 'First' }] },
      { kind: 'question', id: 'q2', questions: [{ ...QSPEC, header: 'Second' }] }
    ]);
    render(<QuestionStickyHost sessionId="s1" />);
    await flush();
    fireEvent.click(screen.getAllByRole('radio')[0]); // pick A
    await flush(50);
    fireEvent.click(screen.getByTestId('question-submit'));
    await flush(50);
    expect(ccsmStub.agentSend).toHaveBeenCalledTimes(1);
    const sent = ccsmStub.agentSend.mock.calls[0][1] as string;
    expect(sent).toContain('Pick one');
    expect(sent).toContain('A');
    // Store should now flag q1 answered, exposing q2 as the active card.
    const state = useStore.getState();
    const blocks = state.messagesBySession.s1;
    const q1 = blocks.find((b) => b.id === 'q1');
    expect(q1?.kind === 'question' && q1.answered).toBe(true);
    // Queue advances: now Second is the only sticky card.
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('on Esc reject: marks block rejected without sending answers', async () => {
    seedBlocks([
      {
        kind: 'question',
        id: 'q1',
        questions: [QSPEC],
        requestId: 'rid-1'
      }
    ]);
    render(<QuestionStickyHost sessionId="s1" />);
    await flush();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await flush(50);
    expect(ccsmStub.agentSend).not.toHaveBeenCalled();
    expect(ccsmStub.agentResolvePermission).toHaveBeenCalledWith('s1', 'rid-1', 'deny');
    const blocks = useStore.getState().messagesBySession.s1;
    const q1 = blocks.find((b) => b.id === 'q1');
    expect(q1?.kind === 'question' && q1.answered && q1.rejected).toBe(true);
  });
});

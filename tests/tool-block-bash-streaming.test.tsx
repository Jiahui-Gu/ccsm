// (#336) Bash command typing-preview render. When ToolBlock receives
// `streamingInput=true` and a `bashPartialCommand`, it should render the
// partial command in the collapsed-row brief slot followed by a span with
// `.bash-typing-caret` (CSS animates the blink). Once `streamingInput`
// flips false (the canonical assistant tool_use event landed and replaced
// the placeholder), the caret disappears and the brief renders normally.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ToolBlock } from '../src/components/chat/blocks/ToolBlock';

afterEach(() => cleanup());

describe('ToolBlock — Bash live-input preview (#336)', () => {
  it('renders the partial command and a typing caret while streamingInput is true', () => {
    const { container, getByTestId } = render(
      <ToolBlock
        name="Bash"
        brief=""
        bashPartialCommand="npm ins"
        streamingInput={true}
      />
    );
    // The brief slot must contain the partial command text.
    expect(container.textContent).toContain('npm ins');
    // The animated caret span is present and uses the CSS class wired in
    // src/styles/global.css.
    const caret = getByTestId('bash-typing-caret');
    expect(caret).toBeTruthy();
    expect(caret.className).toContain('bash-typing-caret');
  });

  it('omits the caret once streamingInput is false (finalized)', () => {
    const { queryByTestId } = render(
      <ToolBlock
        name="Bash"
        brief="npm install"
        input={{ command: 'npm install' }}
        streamingInput={false}
      />
    );
    expect(queryByTestId('bash-typing-caret')).toBeNull();
  });

  it('does not render elapsed/stall chrome while streamingInput is true', () => {
    // No elapsed counter while we're still waiting on the input JSON to
    // finish — the tool hasn't even been dispatched yet.
    const { queryByTestId } = render(
      <ToolBlock
        name="Bash"
        brief=""
        bashPartialCommand="ls"
        streamingInput={true}
        now={Date.now()}
      />
    );
    expect(queryByTestId('tool-elapsed')).toBeNull();
  });
});

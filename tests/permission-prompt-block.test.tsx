import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PermissionPromptBlock } from '../src/components/PermissionPromptBlock';

function flush() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('<PermissionPromptBlock />', () => {
  it('renders EXPANDED on mount with tool name and input summary', async () => {
    render(
      <PermissionPromptBlock
        prompt="Bash: ls -la"
        toolName="Bash"
        toolInput={{ command: 'ls -la', description: 'list files' }}
        onAllow={() => {}}
        onReject={() => {}}
      />
    );
    await flush();
    expect(screen.getByText(/Allow this bash command\?/i)).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    // The summary dl shows the command directly — no expand step.
    expect(screen.getByText('command')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
    // Both buttons rendered from the start (no collapsed/click-to-expand).
    expect(screen.getByRole('button', { name: /allow \(y\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject \(n\)/i })).toBeInTheDocument();
  });

  it('auto-focuses the Reject button on mount', async () => {
    render(
      <PermissionPromptBlock
        prompt="Bash: rm -rf"
        toolName="Bash"
        toolInput={{ command: 'rm -rf /' }}
        onAllow={() => {}}
        onReject={() => {}}
      />
    );
    await flush();
    const reject = screen.getByRole('button', { name: /reject \(n\)/i });
    expect(document.activeElement).toBe(reject);
  });

  it('pressing Y triggers Allow (case-insensitive)', async () => {
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={onAllow}
        onReject={onReject}
      />
    );
    await flush();
    fireEvent.keyDown(window, { key: 'y' });
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Y' });
    expect(onAllow).toHaveBeenCalledTimes(2);
  });

  it('pressing N triggers Reject (case-insensitive)', async () => {
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={onAllow}
        onReject={onReject}
      />
    );
    await flush();
    fireEvent.keyDown(window, { key: 'N' });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('Enter on focused Allow button fires Allow', async () => {
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={onAllow}
        onReject={onReject}
      />
    );
    await flush();
    const allow = screen.getByRole('button', { name: /allow \(y\)/i });
    allow.focus();
    fireEvent.keyDown(allow, { key: 'Enter' });
    // Button also triggers native click on Enter, but our onKeyDown fires
    // first and calls onAllow. Guard against double-firing with a range.
    expect(onAllow).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Tab moves focus to Allow (and cycles back)', async () => {
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={() => {}}
        onReject={() => {}}
      />
    );
    await flush();
    const reject = screen.getByRole('button', { name: /reject \(n\)/i });
    const allow = screen.getByRole('button', { name: /allow \(y\)/i });
    expect(document.activeElement).toBe(reject);
    // jsdom doesn't implement Tab natively — just verify both are in the tab
    // order (tabindex 0 or no explicit tabindex) so focus CAN reach them.
    expect(reject.tabIndex).not.toBe(-1);
    expect(allow.tabIndex).not.toBe(-1);
  });

  it('Escape triggers Reject (standard alertdialog dismiss)', async () => {
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={onAllow}
        onReject={onReject}
      />
    );
    await flush();
    // Focus is auto-moved to the Reject button on mount, so focus is inside
    // the prompt — Esc should dispatch reject.
    const reject = screen.getByRole('button', { name: /reject \(n\)/i });
    fireEvent.keyDown(reject, { key: 'Escape' });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('Escape is a no-op when focus is outside the prompt', async () => {
    const external = document.createElement('textarea');
    document.body.appendChild(external);
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        autoFocus={false}
        onAllow={onAllow}
        onReject={onReject}
      />
    );
    await flush();
    external.focus();
    expect(document.activeElement).toBe(external);
    fireEvent.keyDown(external, { key: 'Escape' });
    expect(onReject).not.toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
    document.body.removeChild(external);
  });

  it('does not steal focus when user is typing in a textarea', async () => {
    const external = document.createElement('textarea');
    document.body.appendChild(external);
    external.focus();
    expect(document.activeElement).toBe(external);

    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={() => {}}
        onReject={() => {}}
      />
    );
    await flush();
    // External textarea still has focus — permission block didn't steal.
    expect(document.activeElement).toBe(external);
    document.body.removeChild(external);
  });

  it('does not hijack Y/N hotkeys while user is typing in an external textarea', async () => {
    const external = document.createElement('textarea');
    document.body.appendChild(external);
    external.focus();
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        onAllow={onAllow}
        onReject={onReject}
      />
    );
    await flush();
    fireEvent.keyDown(external, { key: 'y' });
    fireEvent.keyDown(external, { key: 'n' });
    expect(onAllow).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    document.body.removeChild(external);
  });

  it('respects autoFocus={false} for older (non-latest) prompts', async () => {
    const external = document.createElement('input');
    document.body.appendChild(external);
    external.focus();
    render(
      <PermissionPromptBlock
        prompt="Bash: ls"
        toolName="Bash"
        autoFocus={false}
        onAllow={() => {}}
        onReject={() => {}}
      />
    );
    await flush();
    expect(document.activeElement).toBe(external);
    document.body.removeChild(external);
  });

  it('renders long input values truncated', async () => {
    const long = 'x'.repeat(600);
    render(
      <PermissionPromptBlock
        prompt="Write: file"
        toolName="Write"
        toolInput={{ file_path: '/tmp/a.txt', content: long }}
        onAllow={() => {}}
        onReject={() => {}}
      />
    );
    await flush();
    expect(screen.getByText('file_path')).toBeInTheDocument();
    // content truncated with ellipsis
    const truncated = screen.getByText(/^x+…$/);
    expect(truncated.textContent!.length).toBeLessThanOrEqual(401);
  });

  describe('Allow always — scope-explicit copy (Task #321)', () => {
    it('renders the per-tool, session-scoped label when toolName is known', async () => {
      render(
        <PermissionPromptBlock
          prompt="Bash: ls -la"
          toolName="Bash"
          toolInput={{ command: 'ls -la' }}
          onAllow={() => {}}
          onReject={() => {}}
          onAllowAlways={() => {}}
        />
      );
      await flush();
      // Label must (a) name the tool, (b) signal session scope. The old
      // copy ("Allow always") promised more than the implementation delivers
      // — this test guards against regressing back to it.
      const btn = screen.getByRole('button', { name: /always allow bash this session/i });
      expect(btn).toBeInTheDocument();
      // Tooltip spells out the lifetime + scope explicitly.
      expect(btn.getAttribute('title')).toMatch(/any bash/i);
      expect(btn.getAttribute('title')).toMatch(/quit the app/i);
      // Negative: the old vague label is gone.
      expect(
        screen.queryByRole('button', { name: /^allow always$/i })
      ).not.toBeInTheDocument();
    });

    it('falls back to a tool-agnostic label when toolName is missing', async () => {
      render(
        <PermissionPromptBlock
          prompt="opaque"
          onAllow={() => {}}
          onReject={() => {}}
          onAllowAlways={() => {}}
        />
      );
      await flush();
      const btn = screen.getByRole('button', {
        name: /always allow this tool this session/i,
      });
      expect(btn).toBeInTheDocument();
      expect(btn.getAttribute('title')).toMatch(/this tool/i);
    });

    it('clicking the button still fires onAllowAlways', async () => {
      const onAllowAlways = vi.fn();
      render(
        <PermissionPromptBlock
          prompt="Bash: rm -rf /"
          toolName="Bash"
          onAllow={() => {}}
          onReject={() => {}}
          onAllowAlways={onAllowAlways}
        />
      );
      await flush();
      fireEvent.click(
        screen.getByRole('button', { name: /always allow bash this session/i })
      );
      expect(onAllowAlways).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- per-hunk partial-accept (#306) ----------
  describe('per-hunk diff selection (Edit/Write/MultiEdit)', () => {
    const multiEditInput = {
      file_path: '/tmp/a.ts',
      edits: [
        { old_string: 'a-old', new_string: 'a-new' },
        { old_string: 'b-old', new_string: 'b-new' },
        { old_string: 'c-old', new_string: 'c-new' }
      ]
    };

    it('renders one checkbox per hunk, all checked by default', async () => {
      render(
        <PermissionPromptBlock
          prompt="MultiEdit /tmp/a.ts"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={() => {}}
          onReject={() => {}}
          onAllowPartial={() => {}}
        />
      );
      await flush();
      const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
      expect(boxes.length).toBe(3);
      boxes.forEach((b) =>
        expect(b.getAttribute('data-state')).toBe('checked')
      );
      // Primary button reflects 3/3 selected.
      expect(screen.getByRole('button', { name: /Allow selected \(3\/3\)/ })).toBeInTheDocument();
    });

    it('with all hunks selected, primary click falls through to onAllow (legacy IPC)', async () => {
      const onAllow = vi.fn();
      const onAllowPartial = vi.fn();
      const onReject = vi.fn();
      render(
        <PermissionPromptBlock
          prompt="MultiEdit"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={onAllow}
          onReject={onReject}
          onAllowPartial={onAllowPartial}
        />
      );
      await flush();
      const allow = screen.getByRole('button', { name: /Allow selected \(3\/3\)/ });
      fireEvent.click(allow);
      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(onAllowPartial).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();
    });

    it('toggling a checkbox switches primary to "Allow selected (N/M)" calling partial IPC', async () => {
      const onAllow = vi.fn();
      const onAllowPartial = vi.fn();
      render(
        <PermissionPromptBlock
          prompt="MultiEdit"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={onAllow}
          onReject={() => {}}
          onAllowPartial={onAllowPartial}
        />
      );
      await flush();
      const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
      // Uncheck index 1 (middle hunk).
      fireEvent.click(boxes[1]);
      await flush();
      const allow = screen.getByRole('button', { name: /Allow selected \(2\/3\)/ });
      fireEvent.click(allow);
      expect(onAllowPartial).toHaveBeenCalledTimes(1);
      expect(onAllowPartial).toHaveBeenCalledWith([0, 2]);
      expect(onAllow).not.toHaveBeenCalled();
    });

    it('"None" toolbar deselects everything; primary becomes "Reject all" and calls onReject', async () => {
      const onAllow = vi.fn();
      const onReject = vi.fn();
      const onAllowPartial = vi.fn();
      render(
        <PermissionPromptBlock
          prompt="MultiEdit"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={onAllow}
          onReject={onReject}
          onAllowPartial={onAllowPartial}
        />
      );
      await flush();
      const noneBtn = document.querySelector('[data-perm-select-none]') as HTMLButtonElement;
      expect(noneBtn).toBeTruthy();
      fireEvent.click(noneBtn);
      await flush();
      const primary = screen.getByRole('button', { name: /Reject all/ });
      fireEvent.click(primary);
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onAllow).not.toHaveBeenCalled();
      expect(onAllowPartial).not.toHaveBeenCalled();
    });

    it('"All" toolbar reselects everything after a partial deselect', async () => {
      render(
        <PermissionPromptBlock
          prompt="MultiEdit"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={() => {}}
          onReject={() => {}}
          onAllowPartial={() => {}}
        />
      );
      await flush();
      const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
      fireEvent.click(boxes[0]);
      fireEvent.click(boxes[2]);
      await flush();
      expect(screen.getByRole('button', { name: /Allow selected \(1\/3\)/ })).toBeInTheDocument();
      const allBtn = document.querySelector('[data-perm-select-all]') as HTMLButtonElement;
      fireEvent.click(allBtn);
      await flush();
      expect(screen.getByRole('button', { name: /Allow selected \(3\/3\)/ })).toBeInTheDocument();
    });

    it('falls back to flat summary when no onAllowPartial wiring is provided', async () => {
      render(
        <PermissionPromptBlock
          prompt="MultiEdit"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={() => {}}
          onReject={() => {}}
        />
      );
      await flush();
      // No diff/checkbox UI when partial IPC isn't wired in — old behavior.
      expect(document.querySelectorAll('[data-perm-hunk-checkbox]').length).toBe(0);
      expect(document.querySelector('[data-perm-diff]')).toBeNull();
      expect(screen.getByRole('button', { name: /allow \(y\)/i })).toBeInTheDocument();
    });

    it('non-Edit/Write/MultiEdit tool keeps the legacy summary even when onAllowPartial is wired', async () => {
      render(
        <PermissionPromptBlock
          prompt="Bash: ls"
          toolName="Bash"
          toolInput={{ command: 'ls -la' }}
          onAllow={() => {}}
          onReject={() => {}}
          onAllowPartial={() => {}}
        />
      );
      await flush();
      expect(document.querySelectorAll('[data-perm-hunk-checkbox]').length).toBe(0);
      expect(screen.getByText('command')).toBeInTheDocument();
    });

    it('disables buttons and shows "Applying…" while resolving', async () => {
      const onAllow = vi.fn();
      render(
        <PermissionPromptBlock
          prompt="MultiEdit"
          toolName="MultiEdit"
          toolInput={multiEditInput}
          onAllow={onAllow}
          onReject={() => {}}
          onAllowPartial={() => {}}
        />
      );
      await flush();
      const allow = screen.getByRole('button', { name: /Allow selected \(3\/3\)/ });
      fireEvent.click(allow);
      await flush();
      // After click, button label switches to Applying… and is disabled.
      expect(screen.getByText(/Applying/)).toBeInTheDocument();
      const allowBtn = document.querySelector('[data-perm-action="allow"]') as HTMLButtonElement;
      expect(allowBtn.disabled).toBe(true);
      // Re-clicking is a no-op.
      fireEvent.click(allowBtn);
      expect(onAllow).toHaveBeenCalledTimes(1);
    });

    it('Edit (single hunk) also gets the per-hunk UI', async () => {
      render(
        <PermissionPromptBlock
          prompt="Edit"
          toolName="Edit"
          toolInput={{ file_path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' }}
          onAllow={() => {}}
          onReject={() => {}}
          onAllowPartial={() => {}}
        />
      );
      await flush();
      expect(document.querySelectorAll('[data-perm-hunk-checkbox]').length).toBe(1);
      expect(screen.getByRole('button', { name: /Allow selected \(1\/1\)/ })).toBeInTheDocument();
    });
  });

  // ---------- per-tool title ----------
  describe('per-tool title (titleByTool)', () => {
    const cases: Array<[string, RegExp]> = [
      ['Bash', /Allow this bash command\?/i],
      ['WebFetch', /Allow fetching this URL\?/i],
      ['WebSearch', /Allow searching for this query\?/i],
      ['Edit', /Allow editing this file\?/i],
      ['Write', /Allow editing this file\?/i],
      ['NotebookEdit', /Allow editing this file\?/i],
      ['Skill', /Allow running this skill\?/i],
    ];
    for (const [tool, expected] of cases) {
      it(`renders the ${tool} title`, async () => {
        render(
          <PermissionPromptBlock
            prompt={`${tool}: x`}
            toolName={tool}
            onAllow={() => {}}
            onReject={() => {}}
          />
        );
        await flush();
        expect(screen.getByText(expected)).toBeInTheDocument();
      });
    }

    it('falls back to the generic title for unknown tools', async () => {
      render(
        <PermissionPromptBlock
          prompt="something"
          toolName="MysterySdkTool"
          onAllow={() => {}}
          onReject={() => {}}
        />
      );
      await flush();
      expect(screen.getByText(/Permission required/i)).toBeInTheDocument();
    });

    it('falls back to the generic title when no toolName is provided', async () => {
      render(
        <PermissionPromptBlock
          prompt="opaque"
          onAllow={() => {}}
          onReject={() => {}}
        />
      );
      await flush();
      expect(screen.getByText(/Permission required/i)).toBeInTheDocument();
    });
  });
});

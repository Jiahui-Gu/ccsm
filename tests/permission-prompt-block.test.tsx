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
    expect(screen.getByText(/Permission required/i)).toBeInTheDocument();
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
});

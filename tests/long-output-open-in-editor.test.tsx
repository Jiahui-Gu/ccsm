// (#51 / P1-16) "Open in editor" hover-only button on LongOutputView.
//
// What we lock in here:
//   - Button is absent for outputs at/below the 50-line threshold AND
//     under the 5 KB byte threshold (49 lines of short text → no button).
//   - Button appears the moment the line count crosses 50 (51 short lines).
//   - Button appears purely from the byte-axis even when line count is low
//     (one big single-line blob >5 KB → button).
//   - Click invokes window.ccsm.toolOpenInEditor with the full text.
//
// We don't assert the hover-only CSS class composition itself in JSDOM
// (no real :hover); instead we assert the className contains the
// `group-hover:opacity-100` token so a regression that strips the
// hover-reveal styling fails this test.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { LongOutputView } from '../src/components/chat/LongOutputView';
import {
  OPEN_IN_EDITOR_LINE_THRESHOLD,
  OPEN_IN_EDITOR_BYTE_THRESHOLD
} from '../src/components/chat/constants';

afterEach(() => {
  cleanup();
  // Reset our IPC bridge stub between cases.
  // @ts-expect-error window.ccsm is the preload bridge type augmented in
  // src/global.d.ts; deleting it here is a test-only escape hatch.
  delete window.ccsm;
});

function lines(n: number): string {
  // Each line is short ASCII so byte length stays well under the 5 KB axis
  // — this lets us isolate the line-count threshold behaviour.
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('LongOutputView — Open in editor button (#51)', () => {
  it('omits the button for outputs at the 49-line boundary', () => {
    const text = lines(OPEN_IN_EDITOR_LINE_THRESHOLD - 1); // 49 lines
    const { queryByTestId } = render(
      <LongOutputView text={text} isError={false} toolName="Read" />
    );
    expect(queryByTestId('tool-output-open-in-editor')).toBeNull();
  });

  it('renders the button once line count crosses 50', () => {
    const text = lines(OPEN_IN_EDITOR_LINE_THRESHOLD + 1); // 51 lines
    const { getByTestId } = render(
      <LongOutputView text={text} isError={false} toolName="Read" />
    );
    const btn = getByTestId('tool-output-open-in-editor');
    expect(btn).toBeTruthy();
    // Hover-reveal styling must be present — button is opacity-0 by default
    // and only fades in via group-hover. A regression that drops this
    // turns the affordance into permanent visual clutter.
    expect(btn.className).toContain('opacity-0');
    expect(btn.className).toContain('group-hover:opacity-100');
  });

  it('renders the button purely from the byte threshold (low line count)', () => {
    // Single line, but well above 5 KB. Threshold logic is OR, not AND.
    const text = 'x'.repeat(OPEN_IN_EDITOR_BYTE_THRESHOLD + 1);
    const { getByTestId } = render(
      <LongOutputView text={text} isError={false} toolName="Grep" />
    );
    expect(getByTestId('tool-output-open-in-editor')).toBeTruthy();
  });

  it('clicking the button calls window.ccsm.toolOpenInEditor with the full text', async () => {
    const text = lines(OPEN_IN_EDITOR_LINE_THRESHOLD + 5);
    const toolOpenInEditor = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/x.txt' });
    // Minimal stub — we only exercise toolOpenInEditor on this path.
    // @ts-expect-error partial bridge for test
    window.ccsm = { toolOpenInEditor };
    const { getByTestId } = render(
      <LongOutputView text={text} isError={false} toolName="Read" />
    );
    fireEvent.click(getByTestId('tool-output-open-in-editor'));
    expect(toolOpenInEditor).toHaveBeenCalledTimes(1);
    expect(toolOpenInEditor).toHaveBeenCalledWith({ content: text });
  });
});

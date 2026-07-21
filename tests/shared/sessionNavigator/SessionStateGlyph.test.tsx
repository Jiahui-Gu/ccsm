import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SessionStateGlyph } from '../../../src/shared/sessionNavigator/presentation';

describe('SessionStateGlyph', () => {
  it.each([
    ['active', 'Active', 'circle'],
    ['idle', 'Idle', 'circle'],
    ['waiting', 'Waiting', 'rect'],
    ['exited', 'Exited', 'path'],
  ] as const)('renders %s with shape and text semantics', (state, label, shape) => {
    const { container } = render(<SessionStateGlyph state={state} label={label} />);

    expect(screen.getByRole('img', { name: label })).toHaveAttribute('data-state', state);
    expect(container.querySelector(`svg ${shape}`)).toBeTruthy();
  });

  // Platform-neutral extension hooks added for Task 4 (desktop StateGlyph
  // delegation, see src/components/ui/StateGlyph.tsx): `decorative` mirrors
  // the aria-hidden-vs-labelled contract the desktop waiting glyph already
  // exposed, and `className` lets a platform adapter attach its own layout
  // classes without forking the shared markup.
  it('decorative=true hides the glyph from the accessibility tree', () => {
    const { container } = render(
      <SessionStateGlyph state="waiting" label="Waiting" decorative />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.getAttribute('role')).toBeNull();
    expect(wrapper.getAttribute('aria-label')).toBeNull();
  });

  it('decorative=false (default) keeps role=img and aria-label', () => {
    const { container } = render(<SessionStateGlyph state="waiting" label="Waiting" />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('role')).toBe('img');
    expect(wrapper.getAttribute('aria-label')).toBe('Waiting');
    expect(wrapper.getAttribute('aria-hidden')).toBeNull();
  });

  it('forwards className onto the wrapper alongside the base glyph class', () => {
    const { container } = render(
      <SessionStateGlyph state="waiting" label="Waiting" className="my-token" />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('class')).toMatch(/ccsm-session-navigator__glyph/);
    expect(wrapper.getAttribute('class')).toMatch(/my-token/);
  });
});

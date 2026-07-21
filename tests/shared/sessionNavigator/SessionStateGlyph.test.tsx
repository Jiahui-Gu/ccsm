import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SessionStateGlyph } from '../../../src/shared/sessionNavigator';

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
});

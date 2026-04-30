import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Segmented } from '../../src/components/settings/Segmented';

type Theme = 'light' | 'dark' | 'system';

describe('Segmented', () => {
  it('renders one role=radio per option and marks the active one aria-checked', () => {
    render(
      <Segmented<Theme>
        value="dark"
        onChange={() => {}}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ]}
      />
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('false');
  });

  it('invokes onChange with the option value when clicked', () => {
    const onChange = vi.fn();
    render(
      <Segmented<Theme>
        value="light"
        onChange={onChange}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(onChange).toHaveBeenCalledWith('system');
  });
});

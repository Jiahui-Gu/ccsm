import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Field } from '../../src/components/settings/Field';

describe('Field', () => {
  it('renders the label, optional hint, and child control', () => {
    render(
      <Field label="Theme" hint="System follows your OS preference.">
        <input data-testid="ctrl" />
      </Field>
    );
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText(/system follows your os preference/i)).toBeInTheDocument();
    expect(screen.getByTestId('ctrl')).toBeInTheDocument();
  });

  it('omits the hint node entirely when no hint is supplied', () => {
    const { container } = render(
      <Field label="Language">
        <input data-testid="ctrl" />
      </Field>
    );
    // Field's hint slot is the `text-meta text-fg-tertiary` div. When
    // omitted, only the label + child should land in the DOM.
    const hintCandidates = container.querySelectorAll('.text-meta.text-fg-tertiary');
    expect(hintCandidates.length).toBe(0);
    expect(screen.getByText('Language')).toBeInTheDocument();
  });
});

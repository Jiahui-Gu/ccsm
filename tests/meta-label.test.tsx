import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MetaLabel } from '../src/components/ui/MetaLabel';

// task #327: MetaLabel must not bake `uppercase` into its base classes.
// Callsites that genuinely need SCREAMING-CASE must opt in via className.
describe('<MetaLabel />', () => {
  it('does not apply uppercase by default', () => {
    const { getByText } = render(<MetaLabel>Built-in</MetaLabel>);
    const span = getByText('Built-in');
    expect(span.className).not.toMatch(/\buppercase\b/);
  });

  it('renders content verbatim (sentence case preserved)', () => {
    const { getByText } = render(<MetaLabel>Recent</MetaLabel>);
    // If `uppercase` were baked in, computed text would still be "Recent"
    // in JSDOM (CSS not applied), so we assert via className above.
    // Here we just confirm the child renders untouched.
    expect(getByText('Recent').textContent).toBe('Recent');
  });

  it('still applies the mono micro-scale by default (xs)', () => {
    const { getByText } = render(<MetaLabel>x</MetaLabel>);
    expect(getByText('x').className).toMatch(/\btext-mono-xs\b/);
    expect(getByText('x').className).toMatch(/\bfont-mono\b/);
  });

  it('switches to mono-sm when size="sm"', () => {
    const { getByText } = render(<MetaLabel size="sm">x</MetaLabel>);
    expect(getByText('x').className).toMatch(/\btext-mono-sm\b/);
  });

  it('lets callsites opt into uppercase explicitly via className', () => {
    const { getByText } = render(
      <MetaLabel className="uppercase">x</MetaLabel>
    );
    expect(getByText('x').className).toMatch(/\buppercase\b/);
  });
});

import { describe, expect, it } from 'vitest';
import { renderMobilePage } from '../mobilePage';

describe('renderMobilePage', () => {
  it('keeps phone fit local and does not emit session.resize', () => {
    const html = renderMobilePage();
    expect(html).not.toContain("type: 'session.resize'");
    expect(html).not.toContain('lastSentCols');
    expect(html).not.toContain('lastSentRows');
  });
});

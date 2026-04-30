// UT for src/components/InstallerCorruptBanner.tsx — pinned conditional
// rendering: the red strip should only mount when the store flag
// `installerCorrupt` is true. The body of the banner comes from i18n (so
// we don't pin literal copy here — just the testid set by the component).
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { InstallerCorruptBanner } from '../../src/components/InstallerCorruptBanner';
import { useStore } from '../../src/stores/store';
import { resetStore } from '../util/resetStore';

afterEach(() => cleanup());
beforeEach(() => resetStore());

describe('<InstallerCorruptBanner />', () => {
  it('renders nothing when installerCorrupt is false (default)', () => {
    const { queryByTestId } = render(<InstallerCorruptBanner />);
    expect(queryByTestId('installer-corrupt-banner')).toBeNull();
  });

  it('renders the banner when the store flag is set', () => {
    act(() => useStore.setState({ installerCorrupt: true }));
    const { getByTestId } = render(<InstallerCorruptBanner />);
    expect(getByTestId('installer-corrupt-banner')).toBeInTheDocument();
  });

  it('mounts when the store flag flips from false → true', () => {
    const { queryByTestId } = render(<InstallerCorruptBanner />);
    // Initial OFF state.
    expect(queryByTestId('installer-corrupt-banner')).toBeNull();
    // Flip ON — banner should appear immediately (AnimatePresence does NOT
    // gate the enter on a delay, only the exit).
    act(() => useStore.setState({ installerCorrupt: true }));
    expect(queryByTestId('installer-corrupt-banner')).toBeInTheDocument();
  });
});

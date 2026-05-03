import '@testing-library/jest-dom/vitest';
import { initI18n } from '../src/i18n';

// macOS jsdom flake guard (PR #974 / Task #286).
//
// Radix UI's <FocusScope> schedules a `setTimeout(..., 0)` on unmount that
// constructs a CustomEvent and calls `container.dispatchEvent(event)` (see
// node_modules/@radix-ui/react-focus-scope/dist/index.mjs:89-98). On
// macos-latest the vitest worker tears the jsdom environment down between
// the moment that timer is queued and the moment it fires, so the
// `container` element ends up orphaned in a different realm than the
// CustomEvent. jsdom's IDL guard then rejects the dispatch with:
//
//   TypeError: Failed to execute 'dispatchEvent' on 'EventTarget':
//     parameter 1 is not of type 'Event'.
//
// All 825 assertion-bearing tests pass; this is pure teardown noise that
// surfaces as an "Unhandled Exception" and fails the macos job only.
// Ubuntu and Windows happen to win the race. We swallow this exact error
// (and only this one — anything else still fails the run loud).
//
// Why a global handler and not a per-test fix: the timer originates inside
// a third-party library at unmount time, after our test's `afterEach`
// completes — there is no app-level seam to flush it from. Patching
// EventTarget.prototype.dispatchEvent globally would mask real bugs;
// gating on the precise message keeps the blast radius to this one
// post-teardown path.
{
  const isRadixDispatchTeardownNoise = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    if (err.name !== 'TypeError') return false;
    return (
      err.message.includes("Failed to execute 'dispatchEvent'") &&
      err.message.includes('parameter 1 is not of type')
    );
  };
  process.on('uncaughtException', (err) => {
    if (isRadixDispatchTeardownNoise(err)) return;
    throw err;
  });
  process.on('unhandledRejection', (reason) => {
    if (isRadixDispatchTeardownNoise(reason)) return;
    throw reason;
  });
}

// Initialize i18next once for the whole test process. Component tests render
// trees that call useTranslation(); without an initialized i18next instance
// `t(key)` returns the raw key, breaking literal-string assertions like
// `getByText('Send')`. Tests that exercise language switching call
// `initI18n` themselves first — it's idempotent.
initI18n('en');

// Global ResizeObserver shim. jsdom doesn't ship one, and react-virtuoso
// (used by ChatStream after the perf rewrite) calls both observe() AND
// unobserve() on its scroller refs during mount/teardown. A few component
// tests install their own per-file stub with only observe/disconnect; we
// cover the gap centrally so nothing else needs to know about it.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver !== 'function') {
  class ResizeObserverShim {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverShim }).ResizeObserver =
    ResizeObserverShim;
}

// react-virtuoso shim for jsdom. Virtuoso decides which items to render
// based on real layout measurements (offsetHeight / scrollHeight) which
// jsdom always reports as 0, so the production component renders zero
// rows in component tests. We replace it with a passthrough that maps
// every item through `itemContent` and renders the Footer beneath. The
// real virtualization is exercised by the e2e harness running against a
// real Chromium where offsetHeight is meaningful.
import { vi } from 'vitest';
import * as React from 'react';
vi.mock('react-virtuoso', () => {
  type ItemContent<T> = (index: number, item: T) => React.ReactNode;
  type Components<C> = {
    Scroller?: React.ComponentType<React.HTMLProps<HTMLDivElement>>;
    List?: React.ComponentType<React.HTMLProps<HTMLDivElement>>;
    Footer?: React.ComponentType<{ context?: C }>;
  };
  type Props<T, C> = {
    data?: T[];
    itemContent?: ItemContent<T>;
    components?: Components<C>;
    context?: C;
    className?: string;
    style?: React.CSSProperties;
  };
  const Virtuoso = React.forwardRef(function Virtuoso<T, C>(
    props: Props<T, C>,
    _ref: React.ForwardedRef<unknown>
  ) {
    const data = props.data ?? [];
    const Scroller =
      props.components?.Scroller ??
      ((p: React.HTMLProps<HTMLDivElement>) => React.createElement('div', p));
    const List =
      props.components?.List ??
      ((p: React.HTMLProps<HTMLDivElement>) => React.createElement('div', p));
    const Footer = props.components?.Footer;
    return React.createElement(
      Scroller,
      { className: props.className, style: props.style },
      React.createElement(
        List,
        null,
        ...data.map((item, index) =>
          React.createElement(
            'div',
            { key: index, 'data-index': index },
            props.itemContent ? props.itemContent(index, item) : null
          )
        )
      ),
      Footer ? React.createElement(Footer, { context: props.context }) : null
    );
  });
  return { Virtuoso };
});


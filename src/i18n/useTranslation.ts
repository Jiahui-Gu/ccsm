// Thin re-export wrapper around `react-i18next`.
//
// Why a wrapper? Components import `useTranslation` from here, never from
// `react-i18next` directly. This keeps a single chokepoint to swap the
// underlying lib (or to inject a test stub) without touching every
// component file. Also lets us narrow the namespace argument to the
// catalogs we actually have.
import { useTranslation as useI18nextTranslation } from 'react-i18next';
import type en from './locales/en';

export type Namespace = keyof typeof en;

export function useTranslation(ns?: Namespace | Namespace[]) {
  return useI18nextTranslation(ns as string | string[] | undefined);
}

// Re-export the i18next instance for non-component code paths (effects,
// stores, etc.) that need `t()` without a hook.
export { i18next } from './index';

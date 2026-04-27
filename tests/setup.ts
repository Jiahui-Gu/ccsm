import '@testing-library/jest-dom/vitest';
import { initI18n } from '../src/i18n';

// Initialize i18next once for the whole test process. Component tests render
// trees that call useTranslation(); without an initialized i18next instance
// `t(key)` returns the raw key, breaking literal-string assertions like
// `getByText('Send')`. Tests that exercise language switching call
// `initI18n` themselves first — it's idempotent.
initI18n('en');

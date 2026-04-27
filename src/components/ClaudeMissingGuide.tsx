import React, { useState } from 'react';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Full-screen page rendered at boot when the `claude` CLI is not on PATH.
 *
 * Background: ccsm shells out to the user's locally-installed Claude CLI
 * (no bundled binary in this code path — see W1/W3). When PATH lookup
 * fails, the rest of the app cannot function, so we replace the entire UI
 * with this guide rather than letting users dig through broken sessions.
 *
 * The re-check button calls `cliBridge.checkClaudeAvailable` so the user
 * can install via npm in a separate terminal and resolve in-place without
 * restarting the app. App wiring (deciding when to mount this vs. the
 * normal shell) lands in W2c.
 */
type Props = { onResolved: () => void };

export function ClaudeMissingGuide({ onResolved }: Props) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const installCommand = 'npm install -g @anthropic-ai/claude-code';

  const onRecheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      // `window.ccsmCliBridge` is typed via `src/cliBridge.d.ts` (added
      // in W2a alongside the TtydPane wiring).
      const bridge = window.ccsmCliBridge;
      if (!bridge) return;
      const result = await bridge.checkClaudeAvailable();
      if (result.available) {
        onResolved();
        return;
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-neutral-950 px-6 text-neutral-100"
      data-testid="claude-missing-guide"
    >
      <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <h1 className="text-lg font-semibold text-neutral-50">
          {t('claudeMissing.title')}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          {t('claudeMissing.body')}
        </p>
        <div className="mt-5">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            {t('claudeMissing.installCommandLabel')}
          </div>
          <code
            className="mt-2 block select-all rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
            data-testid="claude-missing-install-command"
          >
            {installCommand}
          </code>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onRecheck}
            disabled={checking}
            className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="claude-missing-recheck"
          >
            {checking ? t('common.loading') : t('claudeMissing.recheckButton')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ClaudeMissingGuide;

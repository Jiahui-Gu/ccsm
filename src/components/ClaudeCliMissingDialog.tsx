import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as RD from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Copy, ExternalLink, FolderOpen, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { DialogOverlay } from './ui/Dialog';
import { useStore, CLI_MIN_VERSION_SOFT, isVersionBelow } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';

type Tab = 'install' | 'have-it';

type InstallHints = {
  os: string;
  arch: string;
  commands: {
    native?: string;
    packageManager?: string;
    npm: string;
  };
  docsUrl: string;
};

type InstallRow = { id: string; label: string; command: string; hint?: string };

/**
 * First-run wizard for the missing Claude CLI. Blocking modal — the user must
 * either install the CLI, point us at an existing binary, or explicitly
 * minimize to the banner. We render it unconditionally from <App/> and let
 * the store drive open state.
 *
 * Design choices:
 *   - Radix Dialog: reuses the app's focus-trap, escape-to-close behavior is
 *     neutered (onEscapeKeyDown / onPointerDownOutside preventDefault) so the
 *     user can't accidentally dismiss a blocking state.
 *   - No "close X" in the header — the explicit "Minimize" button in the
 *     footer makes the escape hatch deliberate.
 *   - Commands render as selectable <code> blocks with a per-row Copy button.
 *     Copy uses navigator.clipboard (Electron exposes it) and animates a
 *     check-mark for ~1.2s.
 */
export function ClaudeCliMissingDialog() {
  const { t } = useTranslation();
  const cliStatus = useStore((s) => s.cliStatus);
  const closeDialog = useStore((s) => s.closeCliDialog);
  const checkCli = useStore((s) => s.checkCli);

  const [tab, setTab] = useState<Tab>('install');
  const [hints, setHints] = useState<InstallHints | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [successVersion, setSuccessVersion] = useState<string | null>(null);
  const [foundBinary, setFoundBinary] = useState<string | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = cliStatus.state === 'missing' && cliStatus.dialogOpen;

  useEffect(() => {
    if (!open) return;
    if (hints) return;
    const api = window.agentory?.cli;
    if (!api) return;
    void api.getInstallHints().then(setHints).catch(() => {});
  }, [open, hints]);

  // Track whether the missing-CLI dialog was open just before the store
  // flipped to "found". The success flash should only fire as feedback for an
  // in-dialog action (Retry detect / Browse for binary). On automatic startup
  // detection, the dialog is never open, so we must NOT pop the flash — that
  // turned every app launch into a noisy "Claude CLI detected" modal blip.
  const wasMissingDialogOpen = useRef(false);
  useEffect(() => {
    if (open) wasMissingDialogOpen.current = true;
  }, [open]);

  // When the store flips into "found" after a successful retry / browse from
  // inside the dialog, show a brief success flash and then auto-close. Suppress
  // the flash entirely when the transition wasn't user-initiated from the
  // dialog (e.g. the automatic checkCli() that runs on App mount).
  useEffect(() => {
    if (cliStatus.state !== 'found') return;
    if (!wasMissingDialogOpen.current) return;
    if (!successTimer.current) {
      setSuccessVersion(cliStatus.version);
      setFoundBinary(cliStatus.binaryPath);
      successTimer.current = setTimeout(() => {
        setSuccessVersion(null);
        setFoundBinary(null);
        successTimer.current = null;
        wasMissingDialogOpen.current = false;
      }, 1500);
    }
    return () => {
      if (successTimer.current) {
        clearTimeout(successTimer.current);
        successTimer.current = null;
      }
    };
  }, [cliStatus]);

  const rows = useMemo<InstallRow[]>(() => {
    if (!hints) return [];
    const c = hints.commands;
    const out: InstallRow[] = [];
    if (c.native) {
      out.push({
        id: 'native',
        label: hints.os === 'win32' ? t('cli.rowLabelPowerShell') : t('cli.rowLabelShell'),
        command: c.native,
        hint: t('cli.rowHintNative'),
      });
    }
    if (c.packageManager) {
      out.push({
        id: 'pm',
        label: hints.os === 'win32' ? t('cli.rowLabelWinget') : hints.os === 'darwin' ? t('cli.rowLabelHomebrew') : t('cli.rowLabelPackageManager'),
        command: c.packageManager,
      });
    }
    out.push({
      id: 'npm',
      label: t('cli.rowLabelNpm'),
      command: c.npm,
      hint: t('cli.rowHintNpm'),
    });
    return out;
  }, [hints, t]);

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    setBrowseError(null);
    try {
      await checkCli();
    } finally {
      setRetrying(false);
    }
  }

  async function handleBrowse(): Promise<void> {
    const api = window.agentory?.cli;
    if (!api) return;
    setBrowseError(null);
    setConfiguring(true);
    try {
      const picked = await api.browseBinary();
      if (!picked) {
        setConfiguring(false);
        return;
      }
      const res = await api.setBinaryPath(picked);
      if (!res.ok) {
        setBrowseError(res.error);
        setConfiguring(false);
        return;
      }
      // Re-run detect so the store flips to 'found' with the canonical path.
      await checkCli();
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfiguring(false);
    }
  }

  function handleDocs(): void {
    void window.agentory?.cli?.openDocs();
  }

  function onOpenChange(next: boolean): void {
    if (!next) closeDialog();
  }

  const searchedPaths = cliStatus.state === 'missing' ? cliStatus.searchedPaths : [];

  return (
    <RD.Root open={open || successVersion !== null} onOpenChange={onOpenChange}>
      <RD.Portal>
        <DialogOverlay />
        <RD.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-border-default bg-bg-panel surface-highlight',
            'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.04),0_8px_32px_oklch(0_0_0_/_0.45),0_2px_8px_oklch(0_0_0_/_0.25)]',
            'text-fg-primary outline-none',
            'data-[state=open]:animate-[dialogIn_200ms_cubic-bezier(0.32,0.72,0,1)]',
            'data-[state=closed]:opacity-0'
          )}
          style={{ width: '560px' }}
        >
          {successVersion !== null ? (
            <SuccessPane version={successVersion} binaryPath={foundBinary} />
          ) : (
            <>
              <Header searchedPaths={searchedPaths} />
              <Tabs tab={tab} onChange={setTab} />
              <div className="px-5 py-4 min-h-[240px]">
                {tab === 'install' ? (
                  <InstallPane rows={rows} onOpenDocs={handleDocs} />
                ) : (
                  <HaveItPane
                    onBrowse={handleBrowse}
                    configuring={configuring}
                    error={browseError}
                  />
                )}
              </div>
              <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-subtle">
                <button
                  type="button"
                  onClick={closeDialog}
                  className={cn(
                    'text-xs text-fg-tertiary hover:text-fg-secondary',
                    'transition-colors duration-150 outline-none',
                    'focus-visible:text-fg-primary'
                  )}
                >
                  {t('cli.minimizeBanner')}
                </button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleRetry}
                    disabled={retrying}
                  >
                    <motion.span
                      animate={retrying ? { rotate: 360 } : { rotate: 0 }}
                      transition={
                        retrying
                          ? { repeat: Infinity, duration: 0.9, ease: 'linear' }
                          : { duration: 0 }
                      }
                      style={{ display: 'inline-flex' }}
                    >
                      <RefreshCw size={13} className="stroke-[2]" />
                    </motion.span>
                    <span>{retrying ? t('cli.detecting') : t('cli.retryDetect')}</span>
                  </Button>
                </div>
              </div>
            </>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function Header({ searchedPaths }: { searchedPaths: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="px-5 pt-5 pb-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-status-warning-foreground">
          <AlertTriangle size={16} className="stroke-[1.75]" />
        </div>
        <div className="flex-1 min-w-0">
          <RD.Title className="text-base font-semibold text-fg-primary leading-tight">
            {t('cli.dialogTitle')}
          </RD.Title>
          <RD.Description className="mt-1 text-sm text-fg-tertiary">
            {t('cli.dialogDescriptionPrefix')}
            {' '}<code className="font-mono text-mono-md text-fg-secondary">claude</code>{' '}
            {t('cli.dialogDescriptionSuffix')}
          </RD.Description>
          {searchedPaths.length > 0 && (
            <details className="mt-2 text-xs text-fg-disabled">
              <summary className="cursor-pointer hover:text-fg-tertiary select-none">
                {t('cli.whereWeLooked')}
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                {searchedPaths.map((p) => (
                  <li key={p} className="truncate">• {p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const { t } = useTranslation();
  const tabs: { id: Tab; label: string }[] = [
    { id: 'install', label: t('cli.tabInstall') },
    { id: 'have-it', label: t('cli.tabHaveIt') },
  ];
  return (
    <div role="tablist" className="flex items-center gap-1 px-5 border-b border-border-subtle">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'relative h-8 px-3 text-sm outline-none',
            'transition-colors duration-150',
            'focus-visible:text-fg-primary',
            tab === t.id ? 'text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary'
          )}
        >
          {t.label}
          {tab === t.id && (
            <motion.div
              layoutId="cli-tab-underline"
              className="absolute left-0 right-0 -bottom-px h-[2px] bg-accent"
              transition={{ type: 'spring', stiffness: 520, damping: 30 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

function InstallPane({
  rows,
  onOpenDocs,
}: {
  rows: InstallRow[];
  onOpenDocs: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-tertiary">
        {t('cli.pasteHint')}{' '}
        <span className="text-fg-secondary">{t('cli.retryDetectInline')}</span>{' '}
        {t('cli.belowInline')}
      </p>
      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="text-xs text-fg-disabled">{t('cli.loadingCommands')}</div>
        ) : (
          rows.map((row) => <CommandRow key={row.id} row={row} />)
        )}
      </div>
      <button
        type="button"
        onClick={onOpenDocs}
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-fg-secondary',
          'hover:text-fg-primary transition-colors duration-150 outline-none',
          'focus-visible:text-fg-primary'
        )}
      >
        <ExternalLink size={11} className="stroke-[2]" />
        {t('cli.openDocs')}
      </button>
    </div>
  );
}

function CommandRow({ row }: { row: InstallRow }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(row.command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be blocked — silently ignore */
    }
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-mono-sm uppercase tracking-wide text-fg-disabled font-medium">
          {row.label}
        </span>
      </div>
      <div
        className={cn(
          'group relative flex items-center gap-2 rounded-md border border-border-default',
          'bg-bg-elevated hover:border-border-strong transition-colors duration-150'
        )}
      >
        <code
          className="flex-1 min-w-0 truncate px-3 py-2 font-mono text-xs text-fg-primary select-all"
          data-testid={`cli-cmd-${row.id}`}
        >
          {row.command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={t('cli.copyAria', { label: row.label })}
          className={cn(
            'shrink-0 h-7 w-7 mr-1 inline-flex items-center justify-center rounded',
            'text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover',
            'transition-colors duration-150 outline-none',
            'focus-visible:bg-bg-hover focus-visible:text-fg-primary focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.08)]'
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="check"
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.7, opacity: 0 }}
                transition={{ duration: 0.14 }}
                className="text-status-success-foreground"
              >
                <Check size={13} className="stroke-[2.25]" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.7, opacity: 0 }}
                transition={{ duration: 0.14 }}
              >
                <Copy size={13} className="stroke-[2]" />
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>
      {row.hint && (
        <div className="mt-1 text-mono-sm text-fg-disabled">{row.hint}</div>
      )}
    </div>
  );
}

function HaveItPane({
  onBrowse,
  configuring,
  error,
}: {
  onBrowse: () => void;
  configuring: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-tertiary">
        {t('cli.haveItHint')}{' '}
        <code className="font-mono text-mono-md text-fg-secondary">claude</code> {t('cli.binaryLabel')}
        {' '}{t('cli.rememberHint')}
      </p>
      <Button variant="secondary" size="md" onClick={onBrowse} disabled={configuring}>
        <FolderOpen size={13} className="stroke-[2]" />
        <span>{configuring ? t('cli.verifying') : t('cli.browseBinary')}</span>
      </Button>
      {error && (
        <div className="text-xs text-status-error-foreground">
          {error}
        </div>
      )}
      <div className="text-mono-sm text-fg-disabled leading-relaxed">
        {t('cli.verifyHint')}{' '}
        <code className="font-mono text-fg-tertiary">{t('cli.versionFlag')}</code> {t('cli.verifyHintSuffix')}
      </div>
    </div>
  );
}

function SuccessPane({
  version,
  binaryPath,
}: {
  version: string | null;
  binaryPath: string | null;
}) {
  const { t } = useTranslation();
  const belowMin = isVersionBelow(version, CLI_MIN_VERSION_SOFT);
  return (
    <div className="px-5 py-6 flex items-start gap-3">
      <div className="mt-0.5 text-status-success-foreground">
        <Check size={18} className="stroke-[2]" />
      </div>
      <div className="flex-1 min-w-0">
        <RD.Title className="text-base font-semibold text-fg-primary leading-tight">
          {t('cli.detected')}
        </RD.Title>
        <div className="mt-1 text-sm text-fg-tertiary">
          {version ? (
            <>
              {t('cli.foundVersion')} <span className="text-fg-secondary font-mono">{version}</span>
              {belowMin && (
                <span className="ml-1 text-status-warning-foreground">
                  {t('cli.belowRecommended', { min: CLI_MIN_VERSION_SOFT })}
                </span>
              )}
              .
            </>
          ) : (
            <>{t('cli.foundBinaryUnknown')}</>
          )}
        </div>
        {binaryPath && (
          <div className="mt-1 truncate font-mono text-mono-sm text-fg-disabled">{binaryPath}</div>
        )}
      </div>
    </div>
  );
}

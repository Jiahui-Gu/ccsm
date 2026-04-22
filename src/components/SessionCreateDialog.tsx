import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import { Dialog, DialogContent, DialogBody, DialogFooter, DialogClose } from './ui/Dialog';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { cn } from '../lib/cn';
import { useStore, type CreateSessionOptions } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional seed cwd (e.g. from sidebar quick action). */
  initialCwd?: string | null;
};

/**
 * SessionCreateDialog — Radix Dialog that collects the minimum set of fields
 * for a new session. MVP contract:
 *
 *  - `name` is optional; empty falls back to the store's "New session" default.
 *  - `cwd` is required; defaults to the caller-provided seed or the top of
 *    `recentProjects`. Browse opens an OS picker via `window.agentory.pickDirectory`.
 *
 * Worktree handling is no longer surfaced in this dialog: the main process
 * decides automatically — if `cwd` is a git repo it spawns the session inside
 * a fresh worktree branched off the current HEAD; otherwise it runs in `cwd`
 * directly. The user does not need to think about it.
 *
 * Interaction: Enter submits (unless focus is already on the Create button),
 * Esc closes, focus lands on the name input on open.
 */
export function SessionCreateDialog({ open, onOpenChange, initialCwd }: Props) {
  const { t } = useTranslation();
  const createSession = useStore((s) => s.createSession);
  const recentProjects = useStore((s) => s.recentProjects);
  const pushRecentProject = useStore((s) => s.pushRecentProject);

  // CLI-derived recent cwds, populated from main's eager-scan cache. Used as
  // the fallback default when the in-app `recentProjects` history is empty
  // (typical first-run state) and as autocomplete suggestions in all cases.
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const recentCwdsListId = 'session-create-cwd-suggestions';

  const defaultCwd =
    initialCwd ?? recentProjects[0]?.path ?? recentCwds[0] ?? '';
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset on open so reopening gets a clean form (browse-folder side effects
  // between opens shouldn't leak).
  useEffect(() => {
    if (!open) return;
    setName('');
    setCwd(initialCwd ?? recentProjects[0]?.path ?? recentCwds[0] ?? '');
    // Delay focus so the Radix animation doesn't fight the focus move.
    const id = window.setTimeout(() => nameRef.current?.focus(), 40);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fetch the eager-scan cache from main on every open. The IPC resolves
  // immediately when the cache is hot (the eager scan ran at app `ready`),
  // so the user does not see a spinner. Empty result is a no-op — the
  // existing in-app `recentProjects` fallback still applies.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const api = window.agentory;
    if (!api?.recentCwds) return;
    api
      .recentCwds()
      .then((list) => {
        if (cancelled) return;
        setRecentCwds(list);
        // Only seed cwd from the CLI-derived list if the dialog opened with
        // no other source (no caller seed, no in-app history, no edit yet).
        setCwd((current) => {
          if (current.length > 0) return current;
          if (initialCwd != null) return current;
          if (recentProjects.length > 0) return current;
          return list[0] ?? current;
        });
      })
      .catch(() => {
        /* IPC failure is non-fatal — dialog still works without suggestions. */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const browse = useCallback(async () => {
    const picked = await window.agentory?.pickDirectory();
    if (picked) setCwd(picked);
  }, []);

  const canSubmit = cwd.trim().length > 0;

  const submit = useCallback(() => {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) return;
    const opts: CreateSessionOptions = {
      cwd: trimmedCwd,
      name: name.trim() || undefined,
    };
    createSession(opts);
    pushRecentProject(trimmedCwd);
    onOpenChange(false);
  }, [cwd, name, createSession, pushRecentProject, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('sessionCreate.title')}
        description={t('sessionCreate.description')}
        width="520px"
      >
        <DialogBody>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit();
            }}
            className="flex flex-col gap-4"
          >
            <FormField label={t('sessionCreate.name')} hint={t('sessionCreate.nameHint')}>
              <TextInput
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('sessionCreate.namePlaceholder')}
                data-testid="session-create-name"
                maxLength={80}
              />
            </FormField>

            <FormField label={t('sessionCreate.cwd')} hint={t('sessionCreate.cwdHint')}>
              <div className="flex items-center gap-2">
                <TextInput
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder={t('sessionCreate.cwdPlaceholder')}
                  className="flex-1"
                  data-testid="session-create-cwd"
                  list={recentCwds.length > 0 ? recentCwdsListId : undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
                {recentCwds.length > 0 && (
                  <datalist id={recentCwdsListId} data-testid="session-create-cwd-suggestions">
                    {recentCwds.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                )}
                <IconButton
                  variant="raised"
                  size="md"
                  aria-label={t('sessionCreate.browseFolder')}
                  tooltip={t('sessionCreate.browseFolder')}
                  tooltipSide="top"
                  onClick={browse}
                  className="h-7 w-7"
                >
                  <Folder size={13} className="stroke-[1.75]" />
                </IconButton>
              </div>
            </FormField>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{t('sessionCreate.cancel')}</Button>
          </DialogClose>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {t('sessionCreate.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormField({
  label,
  hint,
  children
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-fg-primary mb-1">{label}</label>
      {hint && <div className="text-xs text-fg-tertiary mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}

const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type="text"
        {...rest}
        className={cn(
          'h-7 px-2 rounded-sm bg-bg-elevated border border-border-default',
          'text-sm text-fg-primary placeholder:text-fg-tertiary outline-none',
          'transition-[border-color,box-shadow] duration-150',
          'hover:border-border-strong',
          'focus-visible:border-border-strong focus-visible:shadow-[0_0_0_2px_oklch(0.72_0.14_215_/_0.30)]',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className
        )}
      />
    );
  }
);

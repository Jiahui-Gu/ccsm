import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, GitBranch, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogBody, DialogFooter, DialogClose } from './ui/Dialog';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { cn } from '../lib/cn';
import { useStore, type CreateSessionOptions } from '../stores/store';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional seed cwd (e.g. from sidebar quick action). */
  initialCwd?: string | null;
};

type BranchLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'non-repo' }
  | {
      kind: 'loaded';
      branches: string[];
      currentBranch: string | null;
      repoRoot: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable' };

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const segs = trimmed.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

/**
 * SessionCreateDialog — Radix Dialog that collects the minimum set of fields
 * for a new session. MVP contract:
 *
 *  - `name` is optional; empty falls back to the store's "New session" default.
 *  - `cwd` is required; defaults to the caller-provided seed or the top of
 *    `recentProjects`. Browse opens an OS picker via `window.agentory.pickDirectory`.
 *  - `sourceBranch` dropdown is populated via `window.agentory.worktree.listBranches`
 *    if that IPC is available; otherwise the dropdown hides (dev on this UI
 *    is unblocked while `feat/worktree-core` is in-flight).
 *  - `useWorktree` can only be toggled when the cwd is a git repo.
 *
 * Interaction: Enter submits (unless focus is already on the Create button),
 * Esc closes, focus lands on the name input on open.
 */
export function SessionCreateDialog({ open, onOpenChange, initialCwd }: Props) {
  const createSession = useStore((s) => s.createSession);
  const recentProjects = useStore((s) => s.recentProjects);
  const pushRecentProject = useStore((s) => s.pushRecentProject);

  // CLI-derived recent cwds, populated from main's eager-scan cache. Used as
  // the fallback default when the in-app `recentProjects` history is empty
  // (typical first-run state) and as autocomplete suggestions in all cases.
  // Kept separate from `recentProjects` because the latter is the user's
  // in-app history and shouldn't be polluted by CLI scan results.
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const recentCwdsListId = 'session-create-cwd-suggestions';

  const defaultCwd =
    initialCwd ?? recentProjects[0]?.path ?? recentCwds[0] ?? '';
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [useWorktree, setUseWorktree] = useState(false);
  const [sourceBranch, setSourceBranch] = useState<string>('');
  const [branchState, setBranchState] = useState<BranchLoadState>({ kind: 'idle' });
  const nameRef = useRef<HTMLInputElement>(null);
  // Track in-flight listBranches calls so we drop stale responses after the
  // user switches cwd (or closes the dialog) before a slow `git` shell-out
  // resolves.
  const branchFetchIdRef = useRef(0);

  // Reset on open so reopening gets a clean form (browse-folder side effects
  // between opens shouldn't leak).
  useEffect(() => {
    if (!open) return;
    setName('');
    setCwd(initialCwd ?? recentProjects[0]?.path ?? recentCwds[0] ?? '');
    setUseWorktree(false);
    setSourceBranch('');
    setBranchState({ kind: 'idle' });
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
        // Checking against `defaultCwd` avoids stomping a folder the user
        // already typed during this open.
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

  // Load branches whenever cwd changes. Empty cwd = idle (nothing to probe).
  useEffect(() => {
    if (!open) return;
    const trimmed = cwd.trim();
    if (!trimmed) {
      setBranchState({ kind: 'idle' });
      return;
    }
    const api = window.agentory;
    if (!api?.worktree?.listBranches) {
      // Data layer not wired yet — don't crash, just gray out the dropdown.
      setBranchState({ kind: 'unavailable' });
      return;
    }
    const fetchId = ++branchFetchIdRef.current;
    setBranchState({ kind: 'loading' });
    // The backend (feat/worktree-core) returns a flat `string[]` of branch
    // names and throws on non-git cwds. We surface "not a git repo" as a
    // distinct state by catching that error. `currentBranch` / `repoRoot`
    // are not exposed by the current IPC — leave them unset and let the UI
    // degrade gracefully (first branch wins as the default selection).
    api.worktree
      .listBranches(trimmed)
      .then((branches) => {
        if (fetchId !== branchFetchIdRef.current) return;
        setBranchState({
          kind: 'loaded',
          branches,
          currentBranch: null,
          repoRoot: trimmed
        });
        setSourceBranch((prev) => {
          if (prev && branches.includes(prev)) return prev;
          return branches[0] ?? '';
        });
      })
      .catch((err) => {
        if (fetchId !== branchFetchIdRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        // Heuristic: git complains about "not a git repository" on non-repo
        // cwds. Bucket those into the dedicated non-repo state so the hint
        // reads correctly and the worktree checkbox is disabled.
        if (/not a git repository/i.test(message)) {
          setBranchState({ kind: 'non-repo' });
          return;
        }
        setBranchState({ kind: 'error', message });
      });
  }, [cwd, open]);

  // Worktrees require a git repo. If the cwd isn't one, force the checkbox
  // off so the user can't submit an invalid combination.
  const worktreeAllowed = branchState.kind === 'loaded';
  useEffect(() => {
    if (!worktreeAllowed && useWorktree) setUseWorktree(false);
  }, [worktreeAllowed, useWorktree]);

  const branchOptions = useMemo(() => {
    return branchState.kind === 'loaded' ? branchState.branches : [];
  }, [branchState]);

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
      useWorktree: useWorktree && worktreeAllowed,
      sourceBranch: useWorktree && worktreeAllowed ? sourceBranch || undefined : undefined
    };
    createSession(opts);
    pushRecentProject(trimmedCwd);
    onOpenChange(false);
  }, [cwd, name, useWorktree, worktreeAllowed, sourceBranch, createSession, pushRecentProject, onOpenChange]);

  const branchHint = (() => {
    switch (branchState.kind) {
      case 'idle':
        return 'Pick a working directory to list branches.';
      case 'loading':
        return 'Reading branches…';
      case 'non-repo':
        return 'Not a git repository — worktrees disabled.';
      case 'unavailable':
        return 'Worktree support not loaded yet (data layer pending).';
      case 'error':
        return `Could not read branches: ${branchState.message}`;
      case 'loaded':
        return branchState.branches.length === 0
          ? 'Repository has no branches yet.'
          : `Repository: ${lastSegment(branchState.repoRoot)}`;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New session"
        description="Pick a working directory; optionally isolate the agent on a fresh git worktree."
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
            <FormField label="Name" hint="Optional — defaults to “New session”.">
              <TextInput
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New session"
                data-testid="session-create-name"
                maxLength={80}
              />
            </FormField>

            <FormField label="Working directory" hint="Where the agent should run.">
              <div className="flex items-center gap-2">
                <TextInput
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/path/to/repo"
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
                  aria-label="Browse folder"
                  tooltip="Browse folder"
                  tooltipSide="top"
                  onClick={browse}
                  className="h-7 w-7"
                >
                  <Folder size={13} className="stroke-[1.75]" />
                </IconButton>
              </div>
            </FormField>

            <FormField label="Base branch" hint={branchHint}>
              <div className="flex items-center gap-2">
                <GitBranch
                  size={13}
                  className={cn(
                    'stroke-[1.75] shrink-0',
                    worktreeAllowed ? 'text-fg-tertiary' : 'text-fg-disabled'
                  )}
                />
                <select
                  value={sourceBranch}
                  onChange={(e) => setSourceBranch(e.target.value)}
                  disabled={!worktreeAllowed || branchOptions.length === 0}
                  aria-label="Base branch"
                  data-testid="session-create-branch"
                  className={cn(
                    'flex-1 h-7 px-2 pr-6 rounded-sm bg-bg-elevated border border-border-default',
                    'text-sm text-fg-primary outline-none cursor-pointer',
                    'hover:border-border-strong',
                    'focus-visible:border-border-strong focus-visible:shadow-[0_0_0_2px_oklch(0.72_0.14_215_/_0.30)]',
                    'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border-default'
                  )}
                >
                  {branchState.kind === 'loading' && <option value="">Loading…</option>}
                  {branchState.kind === 'loaded' && branchOptions.length === 0 && (
                    <option value="">(no branches)</option>
                  )}
                  {branchState.kind === 'loaded' && branchState.currentBranch && !branchOptions.includes(branchState.currentBranch) && (
                    <option value={branchState.currentBranch}>{branchState.currentBranch}</option>
                  )}
                  {branchOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                  {!worktreeAllowed && branchState.kind !== 'loading' && (
                    <option value="">(unavailable)</option>
                  )}
                </select>
                {branchState.kind === 'loading' && (
                  <Loader2
                    size={13}
                    className="stroke-[1.75] shrink-0 text-fg-tertiary animate-spin"
                    aria-hidden
                  />
                )}
              </div>
            </FormField>

            <label
              className={cn(
                'inline-flex items-center gap-2 select-none',
                worktreeAllowed ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
              )}
              data-testid="session-create-use-worktree-label"
            >
              <input
                type="checkbox"
                checked={useWorktree}
                disabled={!worktreeAllowed}
                onChange={(e) => setUseWorktree(e.target.checked)}
                className="accent-fg-primary"
                data-testid="session-create-use-worktree"
              />
              <span className="text-sm text-fg-primary">Use git worktree</span>
              <span className="text-xs text-fg-tertiary">
                — isolate this session on its own branch
              </span>
            </label>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            Create session
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

import React, { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogBody, DialogFooter } from './ui/Dialog';
import { Button } from './ui/Button';

type PreflightOk = {
  ok: true;
  branch: string;
  base: string;
  availableBases: string[];
  repoRoot: string;
  suggestedTitle: string;
  suggestedBody: string;
};

export type PrFormSubmit = {
  title: string;
  body: string;
  base: string;
  draft: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preflight: PreflightOk | null;
  submitting: boolean;
  submitError?: string | null;
  onSubmit: (v: PrFormSubmit) => void;
};

export function PrDialog({ open, onOpenChange, preflight, submitting, submitError, onSubmit }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);

  // Seed from preflight each time the dialog opens.
  useEffect(() => {
    if (!open || !preflight) return;
    setTitle(preflight.suggestedTitle);
    setBody(preflight.suggestedBody);
    setBase(preflight.base);
    setDraft(false);
  }, [open, preflight]);

  const baseOptions = useMemo(() => {
    if (!preflight) return [] as string[];
    // Always include the chosen base even if it isn't in availableBases
    // (e.g. preflight fell back to "main" but the user's repo has no
    // origin/main listed — happens on fresh forks).
    const set = new Set<string>(preflight.availableBases);
    if (preflight.base) set.add(preflight.base);
    return Array.from(set).sort();
  }, [preflight]);

  const canSubmit = !submitting && title.trim().length > 0 && base.length > 0 && !!preflight;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Create Pull Request"
        description={
          preflight
            ? `Push ${preflight.branch} → ${base || preflight.base} and open a PR on GitHub.`
            : 'Running preflight checks…'
        }
        width="560px"
        data-testid="pr-dialog"
      >
        <DialogBody>
          {preflight && (
            <div className="flex flex-col gap-3">
              <Field label="Title">
                <input
                  type="text"
                  data-testid="pr-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={submitting}
                  className={inputCx}
                />
              </Field>

              <Field label="Base branch">
                <select
                  data-testid="pr-base"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  disabled={submitting}
                  className={inputCx}
                >
                  {baseOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Body">
                <textarea
                  data-testid="pr-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={submitting}
                  rows={10}
                  className={inputCx + ' font-mono text-xs leading-[18px] resize-y min-h-[180px]'}
                />
              </Field>

              <label className="flex items-center gap-2 text-sm text-fg-secondary select-none">
                <input
                  type="checkbox"
                  data-testid="pr-draft"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                  disabled={submitting}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Open as draft
              </label>

              {submitError && (
                <div
                  role="alert"
                  className="rounded-md border border-state-error/40 bg-state-error-soft/60 px-3 py-2 font-mono text-[11px] leading-[16px] text-state-error-fg whitespace-pre-wrap max-h-[160px] overflow-auto"
                >
                  {submitError}
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="pr-submit"
            onClick={() =>
              onSubmit({
                title: title.trim(),
                body,
                base,
                draft
              })
            }
            disabled={!canSubmit}
          >
            {submitting ? 'Opening…' : 'Open PR'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const inputCx =
  'block w-full rounded-sm border border-border-default bg-bg-elevated px-2 py-1 text-sm ' +
  'text-fg-primary outline-none transition-colors duration-150 ease-out ' +
  'hover:border-border-strong focus:border-accent focus-visible:ring-1 focus-visible:ring-accent ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-tertiary">{label}</span>
      {children}
    </label>
  );
}

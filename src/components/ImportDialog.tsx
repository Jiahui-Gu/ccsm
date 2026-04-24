import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Dialog, DialogContent, DialogBody, DialogFooter, DialogClose } from './ui/Dialog';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';
import { bucketize, type DateBucketKey } from '../utils/date-buckets';
import { useTranslation } from '../i18n/useTranslation';
import { useFocusRestore } from '../lib/useFocusRestore';

type Scannable = {
  sessionId: string;
  cwd: string;
  title: string;
  mtime: number;
  projectDir: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const IMPORT_GROUP_NAME = 'Imported';

export function ImportDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const sessions = useStore((s) => s.sessions);
  const groups = useStore((s) => s.groups);
  const importSession = useStore((s) => s.importSession);
  const createGroup = useStore((s) => s.createGroup);
  const renameGroup = useStore((s) => s.renameGroup);

  const [items, setItems] = useState<Scannable[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<DateBucketKey>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  // a11y: opened from menus / shortcuts (no Radix Trigger), so wire up
  // focus restore manually.
  const { handleCloseAutoFocus } = useFocusRestore(open, {
    fallbackSelector: '[data-session-id][aria-selected="true"], [data-session-id][tabindex="0"]'
  });

  useEffect(() => {
    if (!open) return;
    const api = window.ccsm;
    if (!api) return;
    setLoading(true);
    setSelected(new Set());
    setCollapsed(new Set());
    api
      .scanImportable()
      .then((rows) => {
        const known = new Set(sessions.map((s) => s.id));
        setItems(rows.filter((r) => !known.has(r.sessionId)));
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const buckets = useMemo(() => bucketize(items), [items]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((i) => i.sessionId)));
  };

  const toggleBucket = (ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleCollapse = (key: DateBucketKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const doImport = async () => {
    const api = window.ccsm;
    if (!api || selected.size === 0) return;
    setImporting(true);
    try {
      let groupId = groups.find((g) => g.kind === 'normal' && g.name === IMPORT_GROUP_NAME)?.id;
      if (!groupId) {
        groupId = createGroup(IMPORT_GROUP_NAME);
        renameGroup(groupId, IMPORT_GROUP_NAME);
      }
      const picked = items.filter((i) => selected.has(i.sessionId));
      for (const it of picked) {
        importSession({
          name: it.title,
          cwd: it.cwd,
          groupId,
          resumeSessionId: it.sessionId,
          projectDir: it.projectDir
        });
      }
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('importDialog.title')}
        description={t('importDialog.description')}
        width="640px"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <DialogBody>
          {loading ? (
            <div className="font-mono text-chrome text-fg-tertiary py-6 text-center">{t('importDialog.scanning')}</div>
          ) : items.length === 0 ? (
            <div className="font-mono text-chrome text-fg-tertiary py-6 text-center">
              {t('importDialog.noImportablePrefix')} <span className="text-fg-secondary">~/.claude/projects/</span>.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="font-mono text-chrome text-fg-tertiary hover:text-fg-secondary"
                >
                  {selected.size === items.length ? t('importDialog.deselectAll') : t('importDialog.selectAll')} ({items.length})
                </button>
                <span className="font-mono text-chrome text-fg-tertiary">{t('importDialog.selected', { count: selected.size })}</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto rounded-sm border border-border-subtle">
                {buckets.map((bucket, bIdx) => {
                  const ids = bucket.items.map((i) => i.sessionId);
                  const pickedCount = ids.filter((id) => selected.has(id)).length;
                  const allPicked = pickedCount === ids.length;
                  const isCollapsed = collapsed.has(bucket.key);
                  return (
                    <div
                      key={bucket.key}
                      className={bIdx > 0 ? 'border-t border-border-subtle' : ''}
                    >
                      <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-hover/30">
                        <button
                          type="button"
                          onClick={() => toggleCollapse(bucket.key)}
                          className="flex items-center justify-center w-4 h-4 text-fg-tertiary hover:text-fg-secondary"
                          aria-label={isCollapsed ? t('importDialog.expand') : t('importDialog.collapse')}
                        >
                          {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        </button>
                        <span className="font-mono text-chrome text-fg-secondary flex-1">
                          {bucket.label} · {bucket.items.length}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleBucket(ids)}
                          className="font-mono text-chrome text-fg-tertiary hover:text-fg-secondary"
                        >
                          {allPicked ? t('importDialog.deselectGroup') : t('importDialog.selectGroup')}
                          {pickedCount > 0 && !allPicked && ` (${pickedCount}/${ids.length})`}
                        </button>
                      </div>
                      {!isCollapsed && (
                        <ul className="divide-y divide-border-subtle">
                          {bucket.items.map((it) => {
                            const checked = selected.has(it.sessionId);
                            return (
                              <li
                                key={it.sessionId}
                                onClick={() => toggle(it.sessionId)}
                                className="flex items-start gap-2 px-3 py-2 hover:bg-bg-hover cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggle(it.sessionId)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-0.5 accent-fg-primary"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="font-mono text-chrome text-fg-primary truncate">{it.title}</div>
                                  <div className="font-mono text-mono-sm text-fg-tertiary truncate">
                                    {it.cwd} · {new Date(it.mtime).toLocaleString()}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{t('importDialog.cancel')}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={selected.size === 0 || importing}
            onClick={doImport}
          >
            {importing ? t('importDialog.importing') : t('importDialog.importN', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

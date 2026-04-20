import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogBody, DialogFooter, DialogClose } from './ui/Dialog';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';

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
  const sessions = useStore((s) => s.sessions);
  const groups = useStore((s) => s.groups);
  const importSession = useStore((s) => s.importSession);
  const createGroup = useStore((s) => s.createGroup);
  const renameGroup = useStore((s) => s.renameGroup);

  const [items, setItems] = useState<Scannable[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const api = window.agentory;
    if (!api) return;
    setLoading(true);
    setSelected(new Set());
    api
      .scanImportable()
      .then((rows) => {
        const known = new Set(sessions.map((s) => s.id));
        // Hide sessions whose CLI uuid we've already imported (we tag imported
        // sessions with their resume id via name; a stricter dedup needs a
        // dedicated field — leaving the simple "skip already-known store id"
        // for now since the store id and CLI uuid are different namespaces).
        setItems(rows.filter((r) => !known.has(r.sessionId)));
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // sessions intentionally excluded from deps — we want a one-shot snapshot
    // when the dialog opens, not a re-scan as the user creates sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const doImport = async () => {
    const api = window.agentory;
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
        const newId = importSession({
          name: it.title,
          cwd: it.cwd,
          groupId,
          resumeSessionId: it.sessionId
        });
        void newId;
      }
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Import sessions from Claude Code"
        description="Pick existing CLI transcripts to surface in Agentory. They resume on open."
        width="640px"
      >
        <DialogBody>
          {loading ? (
            <div className="font-mono text-xs text-fg-tertiary py-6 text-center">Scanning…</div>
          ) : items.length === 0 ? (
            <div className="font-mono text-xs text-fg-tertiary py-6 text-center">
              No importable transcripts found in <span className="text-fg-secondary">~/.claude/projects/</span>.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="font-mono text-xs text-fg-tertiary hover:text-fg-secondary"
                >
                  {selected.size === items.length ? 'Deselect all' : 'Select all'} ({items.length})
                </button>
                <span className="font-mono text-xs text-fg-tertiary">{selected.size} selected</span>
              </div>
              <ul className="max-h-[420px] overflow-y-auto rounded-sm border border-border-subtle divide-y divide-border-subtle">
                {items.map((it) => {
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
                        <div className="font-mono text-xs text-fg-primary truncate">{it.title}</div>
                        <div className="font-mono text-[11px] text-fg-tertiary truncate">
                          {it.cwd} · {new Date(it.mtime).toLocaleString()}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={selected.size === 0 || importing}
            onClick={doImport}
          >
            {importing ? 'Importing…' : `Import ${selected.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

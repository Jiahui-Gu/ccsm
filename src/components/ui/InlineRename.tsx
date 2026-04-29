import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

type InlineRenameProps = {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
  className?: string;
  // Visual baseline styles should match the static label being replaced.
  // Consumer passes typography/color so alignment stays pixel-perfect.
  inputClassName?: string;
  placeholder?: string;
  maxLength?: number;
};

export function InlineRename({
  value,
  onCommit,
  onCancel,
  className,
  inputClassName,
  placeholder,
  maxLength = 120
}: InlineRenameProps) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // IME composition guard: blur / outside-pointer / Enter that fire while a
  // composition is in flight must not commit the in-progress candidate.
  // Mirrored by the `e.nativeEvent.isComposing` check on Enter below; we keep
  // a ref so blur / mousedown handlers (which don't see the keydown event)
  // can short-circuit too.
  const composingRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Focus + select existing text so the user can immediately overwrite.
    // We focus once synchronously AND once on the next animation frame.
    // The deferred call is the load-bearing one when InlineRename is mounted
    // from a Radix ContextMenuItem.onSelect — Radix restores focus to the
    // context-menu trigger after the menu closes, which races with our mount
    // effect and would otherwise steal focus from this input.
    el.focus();
    el.select();
    const raf = requestAnimationFrame(() => {
      const cur = ref.current;
      if (!cur) return;
      cur.focus();
      cur.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  function commit() {
    if (composingRef.current) return;
    const next = draftRef.current.trim();
    if (!next || next === value) {
      onCancel();
      return;
    }
    onCommit(next);
  }

  // dnd-kit's pointer listeners on ancestor list rows preventDefault on
  // mousedown, which can swallow the input's blur — so the rename input
  // stays focused after the user clicks elsewhere. Watch the document
  // ourselves and commit/cancel when a click lands outside.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      const el = ref.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      commit();
    }
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={(e) => {
        // Skip Enter while IME composition is active — CJK candidate
        // selection shouldn't commit the rename.
        if (e.nativeEvent.isComposing || (e.nativeEvent as { keyCode?: number }).keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      placeholder={placeholder}
      maxLength={maxLength}
      className={cn(
        'w-full bg-bg-elevated border border-border-strong rounded-sm',
        'px-1.5 -mx-1.5 outline-none',
        'focus:shadow-[0_0_0_2px_var(--color-focus-ring)]',
        inputClassName,
        className
      )}
    />
  );
}

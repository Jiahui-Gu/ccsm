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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  function commit() {
    const next = draft.trim();
    if (!next || next === value) {
      onCancel();
      return;
    }
    onCommit(next);
  }

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
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
        'focus:shadow-[0_0_0_2px_oklch(0.72_0.14_215_/_0.30)]',
        inputClassName,
        className
      )}
    />
  );
}

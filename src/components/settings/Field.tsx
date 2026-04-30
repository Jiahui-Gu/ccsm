import React from 'react';

// Labelled wrapper used by every Settings pane. Keeping it as a shared atom
// ensures the label/hint typography stays consistent across panes — a stray
// per-pane copy has historically drifted on font size + spacing.
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label className="block text-chrome font-medium text-fg-primary mb-1">{label}</label>
      {hint && <div className="text-meta text-fg-tertiary mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}

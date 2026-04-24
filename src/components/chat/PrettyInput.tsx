import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../i18n/useTranslation';
import { LONG_STRING_THRESHOLD } from './constants';

// Pretty-prints tool input with 2-space indent, subtle syntax coloring
// (keys vs strings vs other), and click-to-expand for long string values.
// Keeps the pre element copy-friendly: expanded content is inline plain text.
export function PrettyInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (path: string) =>
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));

  function render(value: unknown, indent: number, path: string): React.ReactNode[] {
    const pad = '  '.repeat(indent);
    if (value === null) return [<span key={path} className="text-fg-tertiary">null</span>];
    if (typeof value === 'boolean' || typeof value === 'number') {
      return [<span key={path} className="text-fg-secondary">{String(value)}</span>];
    }
    if (typeof value === 'string') {
      const long = value.length > LONG_STRING_THRESHOLD;
      if (long && !expanded[path]) {
        return [
          <span key={`${path}:open`} className="text-fg-tertiary">&quot;</span>,
          <span key={`${path}:body`} className="text-state-running/90 whitespace-pre-wrap">
            {value.slice(0, LONG_STRING_THRESHOLD)}
          </span>,
          <span key={`${path}:ell`} className="text-fg-tertiary">…</span>,
          <button
            key={`${path}:btn`}
            type="button"
            onClick={() => toggle(path)}
            className="ml-1.5 px-1 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring"
            aria-expanded={false}
          >
            {t('chat.expandStringChars', { count: value.length - LONG_STRING_THRESHOLD })}
          </button>,
          <span key={`${path}:close`} className="text-fg-tertiary">&quot;</span>
        ];
      }
      return [
        <span key={`${path}:open`} className="text-fg-tertiary">&quot;</span>,
        <span key={`${path}:body`} className="text-state-running/90 whitespace-pre-wrap">{value}</span>,
        <span key={`${path}:close`} className="text-fg-tertiary">&quot;</span>,
        long ? (
          <button
            key={`${path}:btn`}
            type="button"
            onClick={() => toggle(path)}
            className="ml-1.5 px-1 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring"
            aria-expanded={true}
          >
            {t('chat.collapseString')}
          </button>
        ) : null
      ];
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return [<span key={path}>[]</span>];
      const parts: React.ReactNode[] = [<span key={`${path}:o`}>[</span>, '\n'];
      value.forEach((item, i) => {
        parts.push(pad + '  ');
        parts.push(...render(item, indent + 1, `${path}.${i}`));
        if (i < value.length - 1) parts.push(',');
        parts.push('\n');
      });
      parts.push(pad, <span key={`${path}:c`}>]</span>);
      return parts;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return [<span key={path}>{'{}'}</span>];
      const parts: React.ReactNode[] = [<span key={`${path}:o`}>{'{'}</span>, '\n'];
      entries.forEach(([k, v], i) => {
        parts.push(pad + '  ');
        parts.push(
          <span key={`${path}.${k}:k`} className="text-accent">{`"${k}"`}</span>,
          <span key={`${path}.${k}:colon`} className="text-fg-tertiary">: </span>
        );
        parts.push(...render(v, indent + 1, `${path}.${k}`));
        if (i < entries.length - 1) parts.push(',');
        parts.push('\n');
      });
      parts.push(pad, <span key={`${path}:c`}>{'}'}</span>);
      return parts;
    }
    return [<span key={path}>{String(value)}</span>];
  }

  return (
    <AnimatePresence initial={false}>
      <motion.pre
        key="input"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
        className="mt-1 ml-6 pl-3 border-l border-border-subtle text-xs font-mono text-fg-secondary whitespace-pre-wrap mb-1"
      >
        <span className="text-fg-tertiary text-mono-xs uppercase tracking-wider mr-2">{t('chat.inputBytes')}</span>
        {render(input, 0, 'root')}
      </motion.pre>
    </AnimatePresence>
  );
}

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../../../i18n/useTranslation';
import { Button } from '../../ui/Button';
import { StateGlyph } from '../../ui/StateGlyph';

export function PlanBlock({ plan, onAllow, onDeny }: { plan: string; onAllow?: () => void; onDeny?: () => void }) {
  const { t } = useTranslation();
  const rejectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Safer default: focus Reject on mount so an accidental Enter rejects
    // (reversible) instead of approving a potentially destructive plan.
    const t = window.setTimeout(() => rejectRef.current?.focus(), 150);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <motion.div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="plan-title"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="relative my-1 pl-3 pr-2 py-1.5 font-mono text-sm"
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-waiting rounded-l-sm"
      />
      <div id="plan-title" className="flex items-baseline gap-2">
        <StateGlyph state="waiting" size="sm" />
        <span className="font-mono uppercase tracking-wider text-mono-xs text-state-waiting">{t('chat.planTitle')}</span>
      </div>
      <div className="mt-1 max-h-[420px] overflow-y-auto border-l border-border-subtle pl-2">
        <div className="prose prose-invert prose-sm max-w-none font-mono text-sm text-fg-secondary [&_h1]:text-fg-primary [&_h2]:text-fg-primary [&_h3]:text-fg-primary [&_code]:text-fg-primary [&_pre]:bg-bg-elevated [&_pre]:rounded-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button ref={rejectRef} variant="secondary" size="sm" onClick={onDeny}>
          {t('chat.planReject')}
        </Button>
        <Button variant="primary" size="sm" onClick={onAllow}>
          {t('chat.planApprove')}
        </Button>
      </div>
    </motion.div>
  );
}

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Download, Layers, FolderTree, MessageSquare, ArrowRight, ArrowLeft, Check } from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from '../lib/cn';
import { useTranslation } from '../i18n/useTranslation';

type Step = {
  key: string;
  title: string;
  body: string;
  visual: React.ReactNode;
};

type Props = {
  onNewSession: () => void;
  onImport: () => void;
  onSkip: () => void;
};

export function Tutorial({ onNewSession, onImport, onSkip }: Props) {
  const { t } = useTranslation();
  const [stepIdx, setStepIdx] = useState(0);
  const steps: Step[] = [
    {
      key: 'welcome',
      title: t('tutorial.welcomeTitle'),
      body: t('tutorial.welcomeBody'),
      visual: <WelcomeVisual />
    },
    {
      key: 'sessions',
      title: t('tutorial.sessionsTitle'),
      body: t('tutorial.sessionsBody'),
      visual: <SessionsVisual />
    },
    {
      key: 'groups',
      title: t('tutorial.groupsTitle'),
      body: t('tutorial.groupsBody'),
      visual: <GroupsVisual />
    },
    {
      key: 'start',
      title: t('tutorial.startTitle'),
      body: t('tutorial.startBody'),
      visual: <StartVisual />
    }
  ];

  const step = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;
  const isFirst = stepIdx === 0;

  return (
    <div className="relative flex h-full w-full flex-col">
      <button
        type="button"
        onClick={onSkip}
        className="absolute right-4 top-3 z-10 font-mono text-meta text-fg-tertiary hover:text-fg-secondary transition-colors"
      >
        {t('tutorial.skip')}
      </button>
      <div className="flex-1 flex items-center justify-center px-12">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center max-w-4xl w-full">
          <AnimatePresence mode="wait">
            <motion.div
              key={`copy-${step.key}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
              className="space-y-4"
            >
              <div className="font-mono text-mono-sm uppercase tracking-wider text-fg-tertiary">
                {t('tutorial.stepXofY', { current: stepIdx + 1, total: steps.length })}
              </div>
              <h1 className="text-2xl font-semibold text-fg-primary leading-tight">{step.title}</h1>
              <p className="text-body text-fg-secondary leading-relaxed">{step.body}</p>
              {isLast && (
                <div className="flex items-center gap-3 pt-4">
                  <Button variant="primary" size="md" onClick={onNewSession} className="w-44 justify-center">
                    <Plus size={14} className="stroke-[2]" />
                    <span>{t('tutorial.newSessionBtn')}</span>
                  </Button>
                  <Button variant="secondary" size="md" onClick={onImport} className="w-44 justify-center">
                    <Download size={14} className="stroke-[2]" />
                    <span>{t('tutorial.importSessionBtn')}</span>
                  </Button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          <AnimatePresence mode="wait">
            <motion.div
              key={`visual-${step.key}`}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="flex items-center justify-center"
            >
              {step.visual}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <div className="shrink-0 px-12 py-5 flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
          disabled={isFirst}
          className={cn(isFirst && 'invisible')}
        >
          <ArrowLeft size={12} />
          <span>{t('tutorial.back')}</span>
        </Button>
        <div className="flex items-center gap-1.5">
          {steps.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStepIdx(i)}
              aria-label={t('tutorial.goToStepAria', { n: i + 1 })}
              className={cn(
                'h-1.5 rounded-full transition-all duration-200',
                i === stepIdx ? 'w-6 bg-fg-primary' : 'w-1.5 bg-border-strong hover:bg-fg-tertiary'
              )}
            />
          ))}
        </div>
        {isLast ? (
          <Button variant="ghost" size="sm" onClick={onSkip}>
            <Check size={12} />
            <span>{t('tutorial.done')}</span>
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setStepIdx((i) => Math.min(steps.length - 1, i + 1))}>
            <span>{t('tutorial.next')}</span>
            <ArrowRight size={12} />
          </Button>
        )}
      </div>
    </div>
  );
}

function VisualCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full max-w-sm aspect-[4/3] rounded-xl border border-border-subtle bg-bg-elevated/60 backdrop-blur p-4 shadow-[0_24px_48px_-12px_oklch(0_0_0_/_0.5)]">
      {children}
    </div>
  );
}

function WelcomeVisual() {
  return (
    <VisualCard>
      <div className="flex h-full items-center justify-center">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.15, duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
          className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[oklch(0.72_0.14_215)] to-[oklch(0.55_0.18_265)] shadow-lg"
        >
          <MessageSquare size={28} className="text-white stroke-[1.5]" />
        </motion.div>
      </div>
    </VisualCard>
  );
}

function SessionsVisual() {
  const rows = [
    { name: 'Refactor auth middleware', state: 'running' as const },
    { name: 'Investigate flaky test', state: 'waiting' as const },
    { name: 'Sketch landing page copy', state: 'idle' as const }
  ];
  const dotColor = (s: typeof rows[number]['state']) =>
    s === 'running' ? 'bg-[oklch(0.78_0.16_145)]' : s === 'waiting' ? 'bg-[oklch(0.78_0.16_70)]' : 'bg-fg-tertiary';
  return (
    <VisualCard>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <motion.div
            key={r.name}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 + i * 0.07, duration: 0.3 }}
            className="flex items-center gap-2 rounded-md bg-bg-app/60 px-3 py-2 border border-border-subtle"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', dotColor(r.state))} />
            <span className="font-mono text-chrome text-fg-secondary truncate">{r.name}</span>
          </motion.div>
        ))}
      </div>
    </VisualCard>
  );
}

function GroupsVisual() {
  const groups = [
    { name: 'Q2 launch', sessions: ['frontend', 'api', 'infra'] },
    { name: 'Bug triage', sessions: ['issue #4821', 'issue #4830'] }
  ];
  return (
    <VisualCard>
      <div className="space-y-3">
        {groups.map((g, i) => (
          <motion.div
            key={g.name}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.1, duration: 0.3 }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <FolderTree size={11} className="text-fg-tertiary" />
              <span className="font-mono text-mono-sm uppercase tracking-wider text-fg-tertiary">
                {g.name}
              </span>
            </div>
            <div className="ml-4 space-y-1">
              {g.sessions.map((s) => (
                <div key={s} className="flex items-center gap-2 rounded-sm px-2 py-1 bg-bg-app/60 border border-border-subtle">
                  <Layers size={10} className="text-fg-tertiary" />
                  <span className="font-mono text-mono-sm text-fg-secondary">{s}</span>
                </div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
    </VisualCard>
  );
}

function StartVisual() {
  return (
    <VisualCard>
      <div className="flex h-full items-center justify-center gap-3">
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1, duration: 0.3 }}
          className="flex flex-col items-center gap-2 p-4 rounded-lg bg-bg-app/60 border border-border-subtle w-28"
        >
          <Plus size={20} className="text-fg-secondary" />
          <span className="font-mono text-mono-sm text-fg-tertiary">New</span>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2, duration: 0.3 }}
          className="flex flex-col items-center gap-2 p-4 rounded-lg bg-bg-app/60 border border-border-subtle w-28"
        >
          <Download size={20} className="text-fg-secondary" />
          <span className="font-mono text-mono-sm text-fg-tertiary">Import</span>
        </motion.div>
      </div>
    </VisualCard>
  );
}

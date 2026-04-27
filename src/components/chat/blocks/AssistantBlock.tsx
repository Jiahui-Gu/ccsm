import React, { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { CodeBlock } from '../../CodeBlock';
import { Tooltip } from '../../ui/Tooltip';
import { useTranslation } from '../../../i18n/useTranslation';
import type { SkillProvenance } from '../../../types';

// Hoisted to module scope so React.memo's referential equality on
// `<ReactMarkdown components={...}>` holds across re-renders. When this object
// was inline the ChatStream parent would re-create it every store tick, which
// forced react-markdown to re-parse + re-highlight every visible historical
// assistant block on every streamed token (5–30ms × N visible blocks).
const MD_COMPONENTS: Components = {
  // `[overflow-wrap:anywhere]` — long unbreakable runs (URLs, hashes,
  // a 500-char glob of one letter) must wrap inside the chat column,
  // otherwise the assistant prose forces horizontal scroll on the
  // whole row (fp11 dogfood Check F: scrollWidth=4297 vs
  // clientWidth=1006). `anywhere` is preferred over `break-word`
  // because it contributes to min-content sizing — necessary inside
  // the parent `flex` + `min-w-0` container so the inner div
  // actually shrinks. <pre> code blocks keep their own
  // `overflow-x-auto` and are not affected by this rule.
  p: ({ children }) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere] mb-2 last:mb-0">{children}</p>,
  code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { node?: unknown; children?: React.ReactNode }) => {
    const isInline = !className?.startsWith('language-');
    const { node: _node, ...rest } = props as { node?: unknown } & Record<string, unknown>;
    if (isInline) {
      return (
        <code
          className="font-mono text-[0.9em] px-1 py-0.5 rounded bg-bg-elevated text-fg-primary"
          {...rest}
        >
          {children}
        </code>
      );
    }
    const lang = className?.replace(/^language-/, '') ?? '';
    const code = Array.isArray(children)
      ? children.filter((c): c is string => typeof c === 'string').join('')
      : typeof children === 'string'
      ? children
      : '';
    return <CodeBlock code={code} language={lang} />;
  },
  pre: ({ children }) => (
    <pre className="my-2 p-3 rounded-md bg-bg-elevated border border-border-subtle overflow-x-auto font-mono text-chrome whitespace-pre">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-[22px]">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="text-display font-semibold mt-3 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-heading font-semibold mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-heading font-medium mt-2 mb-1">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border-subtle pl-3 my-2 text-fg-secondary">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-chrome">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border-subtle px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border-subtle px-2 py-1 align-top">{children}</td>
};

const REMARK_PLUGINS = [remarkGfm];

interface AssistantBlockProps {
  id?: string;
  text: string;
  streaming?: boolean;
  viaSkill?: SkillProvenance;
}

function AssistantBlockImpl({
  id,
  text,
  streaming,
  viaSkill
}: AssistantBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Mirror UserBlock.handleCopy: writeText with the assistant's plain text
  // (the same string the user sees rendered as markdown). Silently no-op on
  // clipboard-blocked environments rather than spamming a toast.
  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently no-op */
    }
  }

  return (
    <div
      className="group relative flex gap-3 text-body"
      data-type-scale-role="assistant-body"
      data-assistant-block-id={id}
    >
      <span className="text-fg-secondary select-none w-3 shrink-0 font-mono font-semibold leading-[22px]">●</span>
      <div className="text-fg-primary min-w-0 leading-[22px]">
        {viaSkill && (
          <Tooltip content={viaSkill.path ?? viaSkill.name} side="top" align="start">
            <span
              data-testid="assistant-via-skill-badge"
              className="inline-flex items-center gap-1 mb-1 px-1.5 py-px rounded border border-border-subtle bg-bg-elevated text-fg-secondary text-meta font-mono select-none cursor-default align-middle"
            >
              {t('assistantBlock.viaSkill', { name: viaSkill.name })}
            </span>
          </Tooltip>
        )}
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
          {text}
        </ReactMarkdown>
        {streaming && (
          <span
            aria-hidden
            className="inline-block w-[7px] h-[14px] -mb-[2px] ml-0.5 bg-fg-primary/70 align-middle animate-pulse"
          />
        )}
      </div>
      {/* Hover-only action row mirroring UserBlock's pattern. Hidden while the
          assistant is streaming — copying a half-streamed reply would be
          surprising. focus-within keeps it visible during keyboard tab-through. */}
      {!streaming && text && (
        <div
          data-testid="assistant-block-actions"
          className="absolute top-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
        >
          <Tooltip content={copied ? t('chat.userMsgCopied') : t('chat.userMsgCopy')} side="top">
            <button
              type="button"
              aria-label={copied ? t('chat.userMsgCopied') : t('chat.userMsgCopy')}
              data-copied={copied ? 'true' : 'false'}
              onClick={handleCopy}
              className="inline-grid place-items-center h-6 w-6 rounded-md text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:outline-none transition-colors"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

// Memoize so historical assistant blocks skip re-rendering (and re-parsing
// markdown) on every ChatStream store tick. Equality compares the only props
// that actually change render output: text, streaming flag, id, and a stable
// scalar key derived from the viaSkill object (its identity churns even when
// content is unchanged).
function viaSkillKey(v: SkillProvenance | undefined): string | null {
  if (!v) return null;
  return v.path ?? v.name ?? null;
}

export const AssistantBlock = React.memo(AssistantBlockImpl, (prev, next) => {
  return (
    prev.text === next.text &&
    prev.streaming === next.streaming &&
    prev.id === next.id &&
    viaSkillKey(prev.viaSkill) === viaSkillKey(next.viaSkill)
  );
});
AssistantBlock.displayName = 'AssistantBlock';

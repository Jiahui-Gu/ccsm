import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '../../CodeBlock';
import { Tooltip } from '../../ui/Tooltip';
import { useTranslation } from '../../../i18n/useTranslation';
import type { SkillProvenance } from '../../../types';

export function AssistantBlock({
  text,
  streaming,
  viaSkill
}: {
  text: string;
  streaming?: boolean;
  viaSkill?: SkillProvenance;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-3 text-body" data-type-scale-role="assistant-body">
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
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="whitespace-pre-wrap mb-2 last:mb-0">{children}</p>,
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
          }}
        >
          {text}
        </ReactMarkdown>
        {streaming && (
          <span
            aria-hidden
            className="inline-block w-[7px] h-[14px] -mb-[2px] ml-0.5 bg-fg-primary/70 align-middle animate-pulse"
          />
        )}
      </div>
    </div>
  );
}

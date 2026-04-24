import { useCallback, useEffect, useRef, useState } from 'react';
import { Highlight, type PrismTheme } from 'prism-react-renderer';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { Tooltip } from './ui/Tooltip';
import { cn } from '../lib/cn';

// Minimal dark-ish palette that matches the app's accent + state colors. We
// intentionally avoid shipping a full Prism theme — only the eight token types
// that actually appear in our code blocks get a color, everything else falls
// through to `text-fg-primary`.
const theme: PrismTheme = {
  plain: { color: 'var(--color-fg-primary, #e6e6e6)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'oklch(0.55 0 0)', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: 'oklch(0.65 0 0)' } },
    { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], style: { color: 'oklch(0.72 0.15 20)' } },
    { types: ['boolean', 'number'], style: { color: 'oklch(0.72 0.12 65)' } },
    { types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'], style: { color: 'oklch(0.72 0.15 145)' } },
    { types: ['operator', 'entity', 'url', 'variable'], style: { color: 'oklch(0.82 0 0)' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: 'oklch(0.72 0.13 260)' } },
    { types: ['function', 'class-name'], style: { color: 'oklch(0.78 0.12 220)' } },
    { types: ['regex', 'important'], style: { color: 'oklch(0.72 0.15 300)' } }
  ]
};

// Alias common language shortcuts to Prism's expected keys. react-markdown
// hands us className="language-ts" etc.; Prism only knows `tsx`, `typescript`,
// `javascript`. Default back to plain text when we don't recognise the tag.
const LANG_ALIAS: Record<string, string> = {
  ts: 'tsx',
  typescript: 'tsx',
  js: 'jsx',
  javascript: 'jsx',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
  md: 'markdown'
};

function normalize(lang?: string): string {
  if (!lang) return 'text';
  const key = lang.toLowerCase();
  return LANG_ALIAS[key] ?? key;
}

// Tiny copy-to-clipboard control that lives in the corner of a code block.
// Visibility is gated by `group-hover` on the wrapping <div>; keyboard users
// also see it via `focus-visible`. After a successful write the button shows
// a Check icon + "Copied" tooltip for ~1.5s, then reverts.
function CopyButton({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onCopy = useCallback(async () => {
    try {
      // navigator.clipboard requires a secure context; in jsdom and older
      // Electron renderers it can be undefined. Bail early so the UI does NOT
      // claim "Copied" when nothing actually landed on the clipboard.
      if (!navigator.clipboard?.writeText) {
        console.warn('[CodeBlock] clipboard API unavailable');
        return;
      }
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('[CodeBlock] clipboard write failed', err);
    }
  }, [code]);

  const label = copied ? t('chat.codeBlockCopied') : t('chat.codeBlockCopy');

  return (
    <Tooltip content={label} side="left">
      <button
        type="button"
        onClick={onCopy}
        aria-label={label}
        data-copied={copied || undefined}
        className={cn(
          'absolute top-1.5 right-1.5 inline-grid place-items-center',
          'h-6 w-6 rounded-md border border-transparent',
          'text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover',
          'hover:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)]',
          'transition-[opacity,background-color,color,box-shadow] duration-150',
          '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          'data-[copied]:opacity-100 data-[copied]:text-state-success',
          'focus-ring outline-none'
        )}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </button>
    </Tooltip>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = normalize(language);
  const trimmed = code.replace(/\n$/, '');
  return (
    <div className="group relative">
      <Highlight theme={theme} code={trimmed} language={lang}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <code className="font-mono text-chrome whitespace-pre block pr-8">
            {tokens.map((line, i) => {
              const { key: _lk, ...lineProps } = getLineProps({ line, key: i });
              return (
                <div key={i} {...lineProps}>
                  {line.map((token, j) => {
                    const { key: _tk, ...tokenProps } = getTokenProps({ token, key: j });
                    return <span key={j} {...tokenProps} />;
                  })}
                </div>
              );
            })}
          </code>
        )}
      </Highlight>
      <CopyButton code={trimmed} />
    </div>
  );
}

// Inline variant for a single span of code (e.g. a diff line). Returns a span
// so it composes with the diff grid row layout.
export function HighlightedLine({ code, language }: { code: string; language?: string }) {
  const lang = normalize(language);
  return (
    <Highlight theme={theme} code={code} language={lang}>
      {({ tokens, getTokenProps }) => {
        const line = tokens[0] ?? [];
        return (
          <span className="whitespace-pre-wrap">
            {line.map((token, j) => {
              const { key: _tk, ...tokenProps } = getTokenProps({ token, key: j });
              return <span key={j} {...tokenProps} />;
            })}
          </span>
        );
      }}
    </Highlight>
  );
}

// Infer a highlight language from a file path extension (for diff hunks).
export function languageFromPath(filePath: string): string {
  const m = /\.([^./\\]+)$/.exec(filePath);
  if (!m) return 'text';
  return normalize(m[1]);
}

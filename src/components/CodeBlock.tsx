import { Highlight, type PrismTheme } from 'prism-react-renderer';

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

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = normalize(language);
  return (
    <Highlight theme={theme} code={code.replace(/\n$/, '')} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <code className="font-mono text-sm whitespace-pre">
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

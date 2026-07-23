import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileCss = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');

describe('mobile shell CSS', () => {
  it('visually distinguishes an exited-session banner from transport warnings', () => {
    expect(mobileCss).toMatch(
      /\.phone-banner--exited\s*\{[^}]*color:\s*var\(--ccsm-error\)[^}]*\}/s,
    );
  });

  it('defines a two-column terminal shell with an independent horizontal viewport and persistent rail', () => {
    expect(mobileCss).toMatch(
      /\.mobile-terminal\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*24px;[^}]*overflow:\s*hidden;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /\.mobile-terminal__viewport\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*scrollbar-width:\s*none;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /\.mobile-terminal__viewport::\-webkit-scrollbar\s*\{[^}]*display:\s*none;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /\.mobile-terminal-scrollbar\s*\{[^}]*width:\s*24px;[^}]*min-width:\s*24px;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /\.mobile-terminal-scrollbar__thumb\s*\{[^}]*min-height:\s*44px;[^}]*\}/s,
    );
  });

  it('keeps canonical output readable/selectable and exposes left-edge horizontal-pan affordance', () => {
    expect(mobileCss).toMatch(
      /\.mobile-terminal__grid\s*\{[^}]*min-height:\s*100%;[^}]*user-select:\s*text;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /\.mobile-terminal__left-edge-affordance\s*\{[^}]*pointer-events:\s*none;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /\.mobile-terminal--left-edge-affordance-visible\s+\.mobile-terminal__left-edge-affordance\s*\{[^}]*opacity:\s*1;[^}]*\}/s,
    );
  });

  it('hides xterm native vertical scrollbar while keeping forced-colors rail visibility', () => {
    expect(mobileCss).toMatch(
      /\.mobile-terminal\s+\.xterm-viewport\s*\{[^}]*overflow-y:\s*hidden\s*!important;[^}]*\}/s,
    );
    expect(mobileCss).toMatch(
      /@media\s*\(forced-colors:\s*active\)\s*\{[^}]*\.mobile-terminal-scrollbar\s*\{[^}]*border-left:\s*1px\s+solid\s+CanvasText;[^}]*\}[^}]*\.mobile-terminal-scrollbar__thumb\s*\{[^}]*background:\s*Highlight;[^}]*forced-color-adjust:\s*none;[^}]*\}/s,
    );
  });
});

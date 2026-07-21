// Discrete PTY control-key bar (mobile composer/terminal-sync plan, Task 5;
// approved spec "Phone input model", lines 163-201). Fixed, exhaustive map
// of predefined control strings only — Esc, Tab, arrows, Space, digits 1-4,
// Ctrl+C, and Enter. There is no sticky-Ctrl toggle, no arbitrary key
// entry, and no text streaming: every button sends exactly one fixed
// string via `onInput` and nothing else.
//
// This component never calls `focus()` or `blur()` on the composer or the
// terminal — a user tapping a button may naturally receive browser focus
// on that button (ordinary DOM behavior this component does not suppress),
// but the application code here never moves focus itself.

export type TerminalKey = {
  label: string;
  ariaLabel: string;
  data: string;
};

export const TERMINAL_KEYS: readonly TerminalKey[] = [
  { label: 'Esc', ariaLabel: 'Esc', data: '\x1b' },
  { label: 'Tab', ariaLabel: 'Tab', data: '\t' },
  { label: '↑', ariaLabel: 'Up', data: '\x1b[A' },
  { label: '↓', ariaLabel: 'Down', data: '\x1b[B' },
  { label: '←', ariaLabel: 'Left', data: '\x1b[D' },
  { label: '→', ariaLabel: 'Right', data: '\x1b[C' },
  { label: 'Space', ariaLabel: 'Space', data: ' ' },
  ...(['1', '2', '3', '4'] as const).map((data) => ({ label: data, ariaLabel: data, data })),
  { label: '^C', ariaLabel: 'Interrupt', data: '\x03' },
  { label: 'Enter', ariaLabel: 'Enter', data: '\r' },
];

export type TerminalKeyBarProps = {
  enabled: boolean;
  onInput: (data: string) => void;
};

export function TerminalKeyBar({ enabled, onInput }: TerminalKeyBarProps) {
  return (
    <div className="terminal-keybar" role="toolbar" aria-label="Terminal keys">
      {TERMINAL_KEYS.map((key) => (
        <button
          key={key.ariaLabel}
          type="button"
          className="terminal-key"
          aria-label={key.ariaLabel}
          disabled={!enabled}
          onClick={() => onInput(key.data)}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}

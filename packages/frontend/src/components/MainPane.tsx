import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

// Empty xterm instance — no ws, no PTY. T6 wires real I/O.
export function MainPane() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#0d0d0d',
        foreground: '#e5e5e5',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const onResize = (): void => {
      try {
        fitAddon.fit();
      } catch {
        // FitAddon throws if the container is detached; ignore during teardown.
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
    };
  }, []);

  return (
    <div className="main-pane">
      <div
        id="terminal"
        ref={containerRef}
        className="main-pane__terminal"
        data-testid="main-terminal"
      />
    </div>
  );
}

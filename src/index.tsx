import * as Sentry from '@sentry/electron/renderer';
import { ErrorBoundary } from '@sentry/react';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { hydrateStore } from './stores/store';
// Import for its side-effect: attaches clientHandler fns onto the slash
// command registry so InputBar can dispatch them.
import './slash-commands/handlers';
import './styles/global.css';

// All knobs (DSN, environment, opt-out gating) live in the main process
// init. The renderer SDK auto-discovers them via the IPC bridge that
// @sentry/electron/preload installs.
Sentry.init({});

const root = createRoot(document.getElementById('root')!);

hydrateStore().finally(() => {
  root.render(
    <ErrorBoundary
      fallback={
        <div className="p-4 text-fg-tertiary">
          Something went wrong. The error was reported to the developer.
        </div>
      }
    >
      <App />
    </ErrorBoundary>
  );
});

import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { hydrateStore } from './stores/store';
import './styles/global.css';

const root = createRoot(document.getElementById('root')!);

hydrateStore().finally(() => {
  root.render(<App />);
});

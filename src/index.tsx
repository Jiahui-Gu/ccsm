import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import './styles/global.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

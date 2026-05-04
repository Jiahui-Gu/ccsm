// ESLint v9 flat config. Kept intentionally minimal — the project relies on
// tsc for type-level errors and vitest for behavior; eslint catches the
// remaining footguns (unused vars, exhaustive-deps, react-hooks rules).
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
// Register the daemon-local `ccsm` plugin at the root so that root-level
// `lint:app` (eslint . --ext .ts,.tsx) can resolve `ccsm/no-listener-slot-mutation`
// when it sweeps `packages/daemon/**`. The rule definition still lives in
// `packages/daemon/eslint-plugins/`; the per-package config (packages/daemon/
// eslint.config.js) is what sets it to `error`. At the root layer we only
// need the plugin loaded so that inline `eslint-disable ccsm/...` comments
// in daemon source/test files do not produce "Definition for rule was not
// found" errors. Spec ch03 §1 / ch11 §5 / Task #29 (PR #873) context.
import ccsmDaemonPlugin from './packages/daemon/eslint-plugins/ccsm-no-listener-slot-mutation.js';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'scripts/**',
      'tests/**',
      'docs/**',
      'tools/spike-harness/**',
      'webpack.config.js',
      'postcss.config.js',
      'eslint.config.js'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        KeyboardEvent: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDialogElement: 'readonly',
        HTMLSpanElement: 'readonly',
        HTMLLIElement: 'readonly',
        Element: 'readonly',
        NodeList: 'readonly',
        Node: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        MouseEvent: 'readonly',
        PointerEvent: 'readonly',
        FocusEvent: 'readonly',
        DragEvent: 'readonly',
        File: 'readonly',
        FileList: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        ResizeObserver: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        // Web platform globals available in Node 22+ (used by daemon
        // RPC code, e.g. T1.3 auth interceptor) and the Electron main
        // process. Browser code already has these via the DOM lib.
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        // `NodeJS` namespace is also referenced from renderer-side .d.ts
        // files (e.g. cliBridge.d.ts) that mirror preload types — keep it
        // available alongside browser globals.
        NodeJS: 'readonly',
        // webpack DefinePlugin compile-time constant — see webpack.config.js.
        // Replaced inline at build with the package.json version string.
        // Used by src/components/settings/UpdatesPane.tsx as the no-IPC
        // version source (Task #311 round 7 fallback for getVersion absence).
        __APP_VERSION__: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 17+ JSX transform — no need to import React in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // We rely on TypeScript for prop typing; default values via destructuring
      // do not need separate eslint validation.
      'react/display-name': 'off',
      // Allow `_unused` parameter convention.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }
      ],
      // Lots of legitimate `as unknown as ...` for SDK boundary casts.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // TS function overloads legitimately re-declare the same name; defer to
      // the typescript-eslint variant which understands overload signatures.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'error'
    },
    settings: {
      react: { version: 'detect' }
    }
  },
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        // Node.js types namespace (e.g. NodeJS.Timeout) and Web APIs
        // available in modern Node runtimes used by Electron main process.
        NodeJS: 'readonly',
        Electron: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        globalThis: 'readonly',
        global: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        // `Headers` and `Request` are Node 22+ web-platform globals on
        // par with `fetch` / `Response`; daemon RPC code uses `Headers`
        // for Connect-RPC interop (T1.3 auth interceptor).
        Headers: 'readonly',
        Request: 'readonly',
        URLSearchParams: 'readonly'
      }
    }
  },
  {
    // Register the daemon-local `ccsm` plugin for files under
    // packages/daemon/** so root-level `lint:app` can resolve
    // `ccsm/no-listener-slot-mutation` references in inline
    // eslint-disable comments. The rule remains gated to `error`
    // by the per-package config (packages/daemon/eslint.config.js);
    // here we register the plugin only (rules block intentionally
    // empty — root sweep does NOT enforce the daemon-internal rule,
    // it just needs the name to resolve).
    files: ['packages/daemon/**/*.{ts,tsx}'],
    plugins: {
      ccsm: ccsmDaemonPlugin,
    },
  }
];

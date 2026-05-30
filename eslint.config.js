// ESLint v9 flat config. Kept intentionally minimal — the project relies on
// tsc for type-level errors and vitest for behavior; eslint catches the
// remaining footguns (unused vars, exhaustive-deps, react-hooks rules).
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'scripts/**',
      'scratch/**',
      '.mrharness/**',
      'tests/**',
      'docs/**',
      '.claude/**',
      // The cloudflare/ worker is a separate package with its own tsconfig and
      // Workers-runtime globals (Response, Request, DurableObjectNamespace…).
      // It is type-checked by its own `tsc --noEmit` in the cloudflare-worker
      // CI job; the root eslint globals don't model the Workers runtime, so
      // linting it here only produces false no-undef errors.
      'cloudflare/**',
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
        KeyboardEvent: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLSpanElement: 'readonly',
        HTMLLIElement: 'readonly',
        Element: 'readonly',
        NodeList: 'readonly',
        Node: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        MouseEvent: 'readonly',
        WheelEvent: 'readonly',
        EventListenerOptions: 'readonly',
        PointerEvent: 'readonly',
        FocusEvent: 'readonly',
        DragEvent: 'readonly',
        ClipboardEvent: 'readonly',
        ErrorEvent: 'readonly',
        PromiseRejectionEvent: 'readonly',
        DataTransfer: 'readonly',
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
        MediaStream: 'readonly',
        AudioContext: 'readonly',
        ScriptProcessorNode: 'readonly',
        // Browser networking globals used by the phone PWA modules
        // (src/mobile/): WebRTC offerer + Durable Object signaling.
        WebSocket: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCDataChannel: 'readonly',
        RTCIceServer: 'readonly',
        RTCConfiguration: 'readonly',
        RTCPeerConnectionIceEvent: 'readonly',
        MessageEvent: 'readonly',
        URLSearchParams: 'readonly',
        // `NodeJS` namespace is also referenced from renderer-side .d.ts
        // files (e.g. cliBridge.d.ts) that mirror preload types — keep it
        // available alongside browser globals.
        NodeJS: 'readonly'
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
        URLSearchParams: 'readonly'
      }
    }
  },
  {
    // CommonJS test fixtures (spawned as standalone Node child processes, e.g.
    // electron/__tests__/fixtures/wal-writer.cjs). Plain Node scripts — give
    // them Node globals and CJS module semantics.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    }
  }
];

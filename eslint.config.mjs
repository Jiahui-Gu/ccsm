// ESLint v9 flat config. Kept intentionally minimal — the project relies on
// tsc for type-level errors and vitest for behavior; eslint catches the
// remaining footguns (unused vars, exhaustive-deps, react-hooks rules).
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { createRequire } from 'node:module';

// Local custom rules. Loaded via createRequire so the .js (CJS) rule modules
// work under the ESM flat config without a package boundary.
//   - no-direct-native-import (frag-3.5.1 §3.5.1.1.a): forbid direct .node /
//     ccsm_native loads outside the loader shim.
//   - no-uppercase-ccsm-path (Task #132 / frag-11 §11.6): forbid uppercase
//     `CCSM` in path literals (Linux dataRoot must be lowercase `ccsm`).
const require = createRequire(import.meta.url);
const noDirectNativeImport = require('./eslint-rules/no-direct-native-import.js');
const noUppercaseCcsmPath = require('./eslint-rules/no-uppercase-ccsm-path.js');
// Local custom rule: no-handler-without-check (frag-3.4.1 §3.4.1.d).
// Envelope handlers under daemon/src/handlers/** must call a recognised
// validator (Check / validateFoo / planFoo / .check) as their first
// statement.
const noHandlerWithoutCheck = require('./eslint-rules/no-handler-without-check.js');
// Local custom rule: no-floating-cancellation (frag-3.5.1 §3.5.1.3).
// Connect handlers / electron bridge that take an AbortSignal must
// observe it (read .aborted, addEventListener, or throwIfAborted).
const noFloatingCancellation = require('./eslint-rules/no-floating-cancellation.js');
const ccsmLocalPlugin = {
  rules: {
    'no-direct-native-import': noDirectNativeImport,
    'no-uppercase-ccsm-path': noUppercaseCcsmPath,
    'no-handler-without-check': noHandlerWithoutCheck,
    'no-floating-cancellation': noFloatingCancellation,
  },
};

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'scripts/**',
      'tests/**',
      'docs/**',
      'eslint-rules/**',
      'webpack.config.js',
      'postcss.config.js',
      'eslint.config.mjs'
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
        // `NodeJS` namespace is also referenced from renderer-side .d.ts
        // files (e.g. cliBridge.d.ts) that mirror preload types — keep it
        // available alongside browser globals.
        NodeJS: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks,
      'ccsm-local': ccsmLocalPlugin
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Custom: forbid direct .node / ccsm_native loads outside the
      // loader shim. Spec frag-3.5.1 §3.5.1.1.a.
      'ccsm-local/no-direct-native-import': 'error',
      // Task #132 (frag-11 §11.6) — Linux dataRoot must be lowercase `ccsm`.
      'ccsm-local/no-uppercase-ccsm-path': 'error',
      // Custom: every envelope handler in daemon/src/handlers/ must
      // validate its `req` arg as the first statement. Spec frag-3.4.1
      // §3.4.1.d.
      'ccsm-local/no-handler-without-check': 'error',
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
      // Empty `catch {}` is an established pattern across the codebase for
      // best-effort cleanup paths; keep it permitted for catch blocks while
      // continuing to flag genuinely empty code blocks elsewhere.
      'no-empty': ['error', { allowEmptyCatch: true }],
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
    // Node.js context: Electron main, daemon source, installer scripts and
    // root-level config files (vitest.config.ts etc.) all run on Node and
    // need the standard Node globals + a couple of Electron-only types.
    files: [
      'electron/**/*.ts',
      'daemon/src/**/*.ts',
      'daemon/spike-pkg-esm/src/**/*.ts',
      'installer/**/*.{js,ts}',
      '*.config.{js,ts,mjs,cjs}'
    ],
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
        Headers: 'readonly',
        URLSearchParams: 'readonly'
      }
    }
  },
  {
    // ccsm-local/no-floating-cancellation — applied to:
    //   - daemon-side Connect handlers (frag-3.5.1 §3.5.1.3 reviewer
    //     acceptance: every handler taking `signal` must read it).
    //   - electron-side Connect bridge (defense-in-depth: the bridge
    //     itself threads signals; if a future call site wraps a handler
    //     and shadows the param without observing it, this rule catches).
    //
    // Scoped to those directories rather than globally because most
    // codebase code legitimately ignores aborts (UI event handlers,
    // pure transforms, etc.) and a global policy would force pervasive
    // disable comments.
    files: [
      'daemon/src/handlers/**/*.ts',
      'electron/daemonClient/**/*.ts',
    ],
    plugins: {
      'ccsm-local': ccsmLocalPlugin,
    },
    rules: {
      'ccsm-local/no-floating-cancellation': 'error',
    },
  }
];

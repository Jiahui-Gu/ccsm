/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    '**/*.d.ts',
    'packages/*/dist',
    'packages/*/build',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // Frontend-web + shared UI: ban any desktop-shell API usage so the
      // web bundle and the shared @ccsm/ui layer stay portable to Tauri /
      // PWA later (see DESIGN.md §7, §10).
      files: [
        'packages/frontend-web/**/*.{ts,tsx,js,jsx,mjs,cjs}',
        'packages/ui/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'electron',
                message:
                  'Frontend must not import from electron — keep the web bundle desktop-shell agnostic.',
              },
              {
                name: '@tauri-apps/api',
                message:
                  'Frontend must not import from @tauri-apps/api — keep the web bundle desktop-shell agnostic.',
              },
            ],
            patterns: [
              {
                group: ['@tauri-apps/api/*', 'electron/*'],
                message:
                  'Frontend must not import desktop-shell APIs — keep the web bundle portable.',
              },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "MemberExpression[object.name='window'][property.name='electron']",
            message:
              'window.electron is a desktop-shell API and must not be used in the frontend.',
          },
          {
            selector:
              "MemberExpression[object.name='window'][property.name='__TAURI__']",
            message:
              'window.__TAURI__ is a desktop-shell API and must not be used in the frontend.',
          },
          {
            selector:
              "MemberExpression[object.type='MemberExpression'][object.object.name='window'][object.property.name='__TAURI__']",
            message:
              'window.__TAURI__.* is a desktop-shell API and must not be used in the frontend.',
          },
        ],
      },
    },
  ],
};

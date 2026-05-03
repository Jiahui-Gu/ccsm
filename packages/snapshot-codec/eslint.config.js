// Per-package ESLint config. Inherits the repo root flat config and adds
// boundary rules: snapshot-codec is a leaf library (no project deps), so
// any cross-package import is a smell.
import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        // Web platform encoders are part of the standard Node global scope
        // since Node 11; the root config doesn't declare them but our
        // tests and (future) consumers rely on them.
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@ccsm/*'],
            message:
              '@ccsm/snapshot-codec is a leaf library — must not depend on other workspace packages. Codec primitives only (spec ch06 §2).',
          },
          {
            group: ['electron', 'electron/*', 'react', 'react-dom'],
            message: '@ccsm/snapshot-codec is a pure-Node library — UI deps forbidden.',
          },
        ],
      }],
    },
  },
];

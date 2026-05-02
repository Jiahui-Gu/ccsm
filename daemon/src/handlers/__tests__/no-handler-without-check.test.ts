// Unit tests for the custom ESLint rule no-handler-without-check.
//
// Drives the rule via ESLint's RuleTester. Synthetic source files
// pinned with `filename: 'daemon/src/handlers/...ts'` so the path
// gate inside the rule fires.

import { RuleTester } from 'eslint';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const require = createRequire(import.meta.url);
const rule = require(
  path.join(repoRoot, 'eslint-rules', 'no-handler-without-check.js'),
);

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-handler-without-check', rule, {
  valid: [
    {
      // Inline arrow registered via dispatcher.register, validator
      // called as first statement.
      code: `
        dispatcher.register('foo.method', async (req) => {
          const validated = validateFoo(req);
          return doStuff(validated);
        });
      `,
      filename: 'daemon/src/handlers/foo.ts',
    },
    {
      // Factory pattern: const makeFooHandler = (ctx) => async (req) => { Check(...); ... }
      code: `
        export const makeFooHandler = (ctx) => async (req) => {
          Check(FooSchema, req);
          return ctx.doStuff(req);
        };
      `,
      filename: 'daemon/src/handlers/foo.ts',
    },
    {
      // RPC takes no payload — first param is `_req`. Rule must NOT fire
      // even though there is no validator. Mirrors the real
      // healthz / stats handlers.
      code: `
        export function makeHealthzHandler(ctx) {
          return async function handleHealthz(_req) {
            return { ok: true, ctx };
          };
        }
      `,
      filename: 'daemon/src/handlers/healthz.ts',
    },
    {
      // Idempotency guard before the validator (mirrors
      // daemon-shutdown.ts pattern). The rule must allow ONE leading
      // `if (...) return ...;` guard before the validator.
      code: `
        dispatcher.register('daemon.shutdown', async function handle(req, ctx) {
          if (state !== 'idle') {
            return { ack: 'replay' };
          }
          const plan = planShutdown(req, ctx);
          return plan.ack;
        });
      `,
      filename: 'daemon/src/handlers/daemon-shutdown.ts',
    },
  ],
  invalid: [
    {
      // Inline arrow registered, no validator, payload consumed.
      code: `
        dispatcher.register('foo.method', async (req) => {
          return doStuff(req.bar);
        });
      `,
      filename: 'daemon/src/handlers/foo.ts',
      errors: [{ messageId: 'missingCheck' }],
    },
    {
      // Factory with returned arrow, no validator.
      code: `
        export function makeFooHandler(ctx) {
          return async (req) => {
            return ctx.run(req.payload);
          };
        }
      `,
      filename: 'daemon/src/handlers/foo.ts',
      errors: [{ messageId: 'missingCheck' }],
    },
    {
      // `const handleFoo = async (req) => { ... }` — top-level handle*.
      code: `
        export const handleFoo = async (req) => {
          return { echo: req };
        };
      `,
      filename: 'daemon/src/handlers/foo.ts',
      errors: [{ messageId: 'missingCheck' }],
    },
    {
      // Function declaration `handleFoo` consuming req without check.
      code: `
        export function handleBar(req, ctx) {
          const x = req.payload + 1;
          return ctx.send(x);
        }
      `,
      filename: 'daemon/src/handlers/bar.ts',
      errors: [{ messageId: 'missingCheck' }],
    },
    {
      // dispatcher.register inline arrow whose first statement is a
      // non-validator call — must still flag.
      code: `
        dispatcher.register('foo.method', async (req) => {
          logger.info('got req', req);
          return { ok: true };
        });
      `,
      filename: 'daemon/src/handlers/foo.ts',
      errors: [{ messageId: 'missingCheck' }],
    },
  ],
});

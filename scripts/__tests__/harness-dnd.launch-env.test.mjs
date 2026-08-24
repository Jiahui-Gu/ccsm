// RED-first coverage: `harness-dnd.mjs` launches Electron in visible mode
// (`CCSM_E2E_HIDDEN: '0'`), which disables the hidden-harness single-instance
// lock bypass. With the user's installed CCSM already running, Electron loses
// `requestSingleInstanceLock()` and exits 0 before creating a window, so
// Playwright's `electron.launch()` fails with "Process failed to launch".
//
// This test statically parses `scripts/harness-dnd.mjs`'s source (via the
// TypeScript compiler's AST, not a regex) to find the `runHarness(...)` call
// and assert its `launch.env` object literal includes exactly
// `CCSM_E2E_NO_SINGLE_INSTANCE: '1'` beside `CCSM_E2E_HIDDEN: '0'`. Structural
// parsing (rather than a whole-file regex) avoids false-passing on a comment
// or an unrelated object elsewhere in the file that happens to mention the
// same property name.
//
// Importing `harness-dnd.mjs` directly would execute the harness (spawn
// Electron) as a top-level side effect, so this test reads and parses the
// file's source text instead of importing the module.
import { describe, test, expect } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(__dirname, '..', 'harness-dnd.mjs');

/**
 * Parse `scripts/harness-dnd.mjs` and return the `env` object literal
 * (`ts.ObjectLiteralExpression`) passed as `launch.env` to the module's
 * `runHarness(...)` call.
 */
function findRunHarnessLaunchEnvNode() {
  const source = fs.readFileSync(HARNESS_PATH, 'utf8');
  const sourceFile = ts.createSourceFile(
    HARNESS_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS
  );

  let runHarnessCall;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'runHarness'
    ) {
      runHarnessCall = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!runHarnessCall) {
    throw new Error('no runHarness(...) call found in harness-dnd.mjs');
  }

  const specArg = runHarnessCall.arguments[0];
  if (!specArg || !ts.isObjectLiteralExpression(specArg)) {
    throw new Error('runHarness(...) call argument is not an object literal');
  }

  const getProp = (objectLiteral, name) =>
    objectLiteral.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === name
    );

  const launchProp = getProp(specArg, 'launch');
  if (!launchProp || !ts.isObjectLiteralExpression(launchProp.initializer)) {
    throw new Error('runHarness(...) spec has no `launch` object literal');
  }

  const envProp = getProp(launchProp.initializer, 'env');
  if (!envProp || !ts.isObjectLiteralExpression(envProp.initializer)) {
    throw new Error('runHarness(...) spec.launch has no `env` object literal');
  }

  return envProp.initializer;
}

/** Read a string-literal property value out of an object literal AST node. */
function readStringProp(objectLiteral, name) {
  const prop = objectLiteral.properties.find(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name
  );
  if (!prop) return undefined;
  return ts.isStringLiteral(prop.initializer)
    ? prop.initializer.text
    : undefined;
}

describe('harness-dnd.mjs runHarness launch.env (single-instance isolation)', () => {
  test('sets CCSM_E2E_NO_SINGLE_INSTANCE to "1" beside CCSM_E2E_HIDDEN', () => {
    const envNode = findRunHarnessLaunchEnvNode();

    // Sanity: the visible-mode env this fix rides alongside must still be
    // present, so we know we parsed the right object.
    expect(readStringProp(envNode, 'CCSM_E2E_HIDDEN')).toBe('0');

    expect(readStringProp(envNode, 'CCSM_E2E_NO_SINGLE_INSTANCE')).toBe('1');
  });
});

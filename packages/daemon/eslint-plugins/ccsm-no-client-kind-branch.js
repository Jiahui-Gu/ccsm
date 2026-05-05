// Local ESLint plugin: ccsm/no-client-kind-branch
//
// Spec ch15 §3 #24 — `HelloRequest.client_kind` and
// `HelloResponse.listener_id` are deliberately open `string` fields
// reserved for OBSERVABILITY ONLY (logging / metrics / debugging).
// The daemon MUST NOT derive control-flow from their values: no
// behavior should change based on whether `client_kind === 'electron'`,
// nor on a `switch (req.client_kind)` discriminant. Any such branch
// re-introduces the closed-enum coupling the open-string design
// explicitly avoids and would force schema co-evolution between client
// and daemon every time a new caller type appears.
//
// Read uses are explicitly allowed (e.g. `log.info({client_kind:
// req.client_kind})`, `const k = req.client_kind`) — only control-flow
// branching counts as a violation.
//
// Conservative AST heuristic — flag two shapes:
//   1. `SwitchStatement` whose `discriminant` is a `MemberExpression`
//      with `property.name in {client_kind, listener_id}`.
//   2. `IfStatement` / `ConditionalExpression` whose `test` is a
//      `BinaryExpression` (`==` / `===` / `!=` / `!==`) with one side
//      a `MemberExpression` whose `property.name in {client_kind,
//      listener_id}`.
//
// SRP: this is a pure decider. No I/O, no fixers — every match is a
// design-level violation that must be removed (or, in the very rare
// case where a branch is legitimately observability-driven and the
// reviewer agrees, a per-line eslint-disable with justification).

const FORBIDDEN_PROPS = new Set(['client_kind', 'listener_id']);

/** True for `<expr>.client_kind` / `<expr>.listener_id` (non-computed). */
function isForbiddenMemberRead(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (node.computed) return false;
  if (!node.property || node.property.type !== 'Identifier') return false;
  return FORBIDDEN_PROPS.has(node.property.name);
}

/** Pull the forbidden property name from a MemberExpression, or null. */
function forbiddenPropName(node) {
  if (!isForbiddenMemberRead(node)) return null;
  return node.property.name;
}

const COMPARISON_OPS = new Set(['==', '===', '!=', '!==']);

function checkBinaryTest(context, testNode, hostNode) {
  if (!testNode || testNode.type !== 'BinaryExpression') return;
  if (!COMPARISON_OPS.has(testNode.operator)) return;
  const leftProp = forbiddenPropName(testNode.left);
  const rightProp = forbiddenPropName(testNode.right);
  const prop = leftProp || rightProp;
  if (!prop) return;
  context.report({
    node: hostNode,
    messageId: 'compareBranch',
    data: { prop },
  });
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid daemon control-flow branching on HelloRequest.client_kind / HelloResponse.listener_id (open-string observability fields per spec ch15 §3 #24). Read for logging/metrics is allowed.',
      recommended: true,
    },
    messages: {
      switchBranch:
        '`switch` on `{{prop}}` is forbidden — this field is open-string observability only (spec ch15 §3 #24). Do not derive behavior from it; the daemon must treat all client_kind/listener_id values uniformly.',
      compareBranch:
        'Branching on `{{prop}}` (===/==/!=/!==) is forbidden — this field is open-string observability only (spec ch15 §3 #24). Read it for logging/metrics, but do not gate behavior on its value.',
    },
    schema: [],
  },
  create(context) {
    return {
      SwitchStatement(node) {
        const prop = forbiddenPropName(node.discriminant);
        if (!prop) return;
        context.report({
          node,
          messageId: 'switchBranch',
          data: { prop },
        });
      },
      IfStatement(node) {
        checkBinaryTest(context, node.test, node);
      },
      ConditionalExpression(node) {
        checkBinaryTest(context, node.test, node);
      },
    };
  },
};

const plugin = {
  meta: { name: 'ccsm-no-client-kind-branch', version: '0.1.0' },
  rules: {
    'no-client-kind-branch': rule,
  },
};

export default plugin;
export { rule };

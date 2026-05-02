# R0 (zero-rework) review of 11-monorepo-layout.md

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 `gen/go/` and `gen/swift/` directories listed but no codegen entries — empty dirs are not buildable contracts

**Location**: `11-monorepo-layout.md` §2 (`gen/` subdir layout); §4 (commented v0.4 buf.gen.yaml plugins)
**Issue**: The chapter shows `gen/go/` and `gen/swift/` as v0.3 directory placeholders with the v0.4 plugin entries as commented YAML in `buf.gen.yaml`. Empty directories don't survive `git` (require `.gitkeep`) and commented YAML invites contributors to interpret the slot loosely. v0.4 may want to add `gen/kotlin/` for Android — adding a new lang in v0.4 is purely additive (good), but the v0.3 doc claim that "directory comment block in the README explains the v0.4 plan" is documentation-as-architecture.
**Why P1**: Soft-rework risk; not wire-shape but the additivity-of-new-langs contract is documented only by comments.
**Suggested fix**: Drop the `gen/go/` and `gen/swift/` placeholder dirs from v0.3 (they don't exist). Replace the commented YAML plugin block in `buf.gen.yaml` with a `# v0.4: see chapter 11 §8 for additive plugin pattern` pointer. Move the "how to add a new language" explanation into chapter 15 §3 forbidden-patterns as "ALLOWED additive: new `buf.gen.yaml` plugin entry; existing entries unchanged."

### P1.2 ESLint `no-restricted-imports` rule scope undefined — won't catch v0.4 violations of "Electron does not import from daemon"

**Location**: `11-monorepo-layout.md` §5 (per-package responsibility matrix; "enforced by ESLint's `no-restricted-imports` rule")
**Issue**: The chapter says ESLint enforces forbidden imports but doesn't list the actual rules. v0.4 web/iOS package boundaries need similar enforcement; if v0.3 ESLint config only forbids `@ccsm/electron → @ccsm/daemon`, v0.4 contributors won't have rules for `@ccsm/web → @ccsm/daemon`.
**Why P1**: Soft-rework: the rule grows additively in v0.4 — fine — but v0.3 should set the pattern.
**Suggested fix**: In §5 add the literal ESLint rule snippet:
```js
"no-restricted-imports": ["error", { patterns: [
  { group: ["@ccsm/daemon/*", "@ccsm/daemon"], message: "client packages MUST NOT import daemon code" }
]}]
```
applied in `packages/electron/eslint.config.js` (and v0.4 web/ios configs). Add to chapter 15 §3 forbidden-patterns: "removing or weakening the inter-package no-restricted-imports rule is forbidden."

### P1.3 Workspace dep graph shows `@ccsm/proto` as a leaf with no internal deps — but generated code may want shared runtime

**Location**: `11-monorepo-layout.md` §3
**Issue**: `@ccsm/proto` exposes generated code via `gen/ts`. v0.4 web/iOS use the same generated code. In practice connect-es output depends on `@bufbuild/protobuf` runtime; if that's a `dependencies` of `@ccsm/proto`, fine. The chapter doesn't pin it, so the runtime dep version may drift between v0.3 daemon/electron and v0.4 web/ios — leading to wire-format incompatibility from version skew (rare but real).
**Why P1**: Soft-rework / version-pinning hygiene.
**Suggested fix**: Pin `@bufbuild/protobuf` and `@connectrpc/connect` exact versions in `@ccsm/proto/package.json` `dependencies`; v0.4 web/iOS inherit through the workspace dep. Lock "the proto package owns the runtime version" in chapter 15 §3 forbidden-patterns.

/**
 * Vitest wrapper around `scripts/verify-proto-gen-treeshake.ts`.
 *
 * @vitest-environment node
 *
 * Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md ch02 §5
 * Task: #1084 v0.4 T03
 *
 * Builds a Vite bundle whose only import is `CcsmService` from
 * `@ccsm/proto-gen/v1` and asserts:
 *   1. The umbrella service identifier is present in the bundle.
 *   2. None of the per-domain `*Schema` constants leak in (proves that
 *      the wrapper's `export *` chains are tree-shakeable and that
 *      `service_pb.ts` does not pull the full surface).
 *
 * The Vite build runs in a temp dir, so this test does not pollute the
 * repo. It is heavier than a typical unit test (~few seconds for a
 * Vite cold build) so we keep it as a single test case.
 */

import { describe, expect, it } from "vitest";
import { runTreeShakeVerification } from "../../scripts/verify-proto-gen-treeshake";

describe("@ccsm/proto-gen tree-shaking", () => {
  it(
    "single-import bundle drops unrelated domain schemas",
    { timeout: 60_000 },
    async () => {
      const result = await runTreeShakeVerification();

      // Sanity: the symbol we imported MUST be present.
      expect(result.presentSymbols).toContain("CcsmService");

      // The actual tree-shake assertion: per-domain schemas (which
      // service_pb.ts does NOT import) MUST be absent.
      expect(result.absentSymbols).toEqual([]);

      // Log size for the PR body.
      // eslint-disable-next-line no-console
      console.log(
        `[treeshake] bundle ${(result.bundleBytes / 1024).toFixed(2)} KB at ${result.bundlePath}`,
      );
    },
  );
});

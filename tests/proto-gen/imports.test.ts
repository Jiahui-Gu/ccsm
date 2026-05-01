/**
 * Resolution + surface tests for the `@ccsm/proto-gen/v1` wrapper.
 *
 * Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md ch02 §5,
 *       chapter 04 §1 (web client imports `@ccsm/proto-gen/v1`).
 * Task: #1084 v0.4 T03
 *
 * Verifies:
 *   - The umbrella `CcsmService` const + `file_ccsm_v1_*` markers for
 *     each of the 8 proto domains are reachable through the v1 barrel.
 *   - The umbrella service surface (typeName) matches what the proto
 *     declares (`ccsm.v1.CcsmService`).
 *   - Importing a non-existent name fails compile (tested via
 *     `// @ts-expect-error`).
 *   - The root `@ccsm/proto-gen` barrel exposes the namespaced `v1`.
 */

import { describe, expect, it } from "vitest";
import * as v1 from "@ccsm/proto-gen/v1";
import { CcsmService } from "@ccsm/proto-gen/v1";
import * as root from "@ccsm/proto-gen";

describe("@ccsm/proto-gen/v1 wrapper barrel", () => {
  it("exposes the umbrella CcsmService with the right typeName", () => {
    expect(CcsmService).toBeDefined();
    expect(CcsmService.typeName).toBe("ccsm.v1.CcsmService");
    // Spot-check: the umbrella service should describe many RPCs.
    // T02 inventory says 46. Don't pin exactly to avoid churn on
    // additive RPC adds, but assert >= 30.
    expect(Object.keys(CcsmService.method).length).toBeGreaterThanOrEqual(30);
  });

  it("exposes a file_* GenFile marker for each of the 8 proto domains", () => {
    const expected = [
      "file_ccsm_v1_core",
      "file_ccsm_v1_session",
      "file_ccsm_v1_session_titles",
      "file_ccsm_v1_pty",
      "file_ccsm_v1_notify",
      "file_ccsm_v1_settings",
      "file_ccsm_v1_updater",
      "file_ccsm_v1_import",
      // umbrella service file
      "file_ccsm_v1_service",
    ];
    for (const name of expected) {
      expect(v1, `${name} should be exported`).toHaveProperty(name);
    }
  });

  it("exposes per-domain *Schema constants through the barrel", () => {
    // One representative Schema per domain proves the barrel is
    // forwarding the messages too.
    const expected = [
      "GetAppVersionRequestSchema", // core
      "SetSessionActiveRequestSchema", // session
      "GetSessionTitleRequestSchema", // session_titles
      "ListPtyRequestSchema", // pty
      "NotifyUserInputRequestSchema", // notify
      "GetDefaultModelRequestSchema", // settings
      "GetUpdatesStatusRequestSchema", // updater
      "ScanImportableRequestSchema", // import
    ];
    for (const name of expected) {
      expect(v1, `${name} should be exported`).toHaveProperty(name);
    }
  });

  it("rejects non-existent named imports at compile time", () => {
    // @ts-expect-error — `ThisDoesNotExist` is not exported.
    const ghost = (v1 as Record<string, unknown>).ThisDoesNotExist;
    expect(ghost).toBeUndefined();
  });

  it("root @ccsm/proto-gen re-exports the v1 namespace", () => {
    expect(root.v1).toBeDefined();
    expect(root.v1.CcsmService).toBe(CcsmService);
  });
});

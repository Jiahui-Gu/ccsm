// Hand-written root barrel for `@ccsm/proto-gen`.
//
// Currently re-exports the v1 namespace. When `ccsm.v2` lands (proto-break
// flow, see chapter 02 §4) this file will re-export v2 alongside v1 for the
// 1-release deprecation window.
//
// Consumers should prefer the versioned sub-path import to keep imports
// stable across major namespace bumps:
//
//     import { CcsmService } from "@ccsm/proto-gen/v1";
//
// rather than:
//
//     import { CcsmService } from "@ccsm/proto-gen";
//
// This file exists for completeness and to give the alias a non-empty
// resolution target.

export * as v1 from "./ccsm/v1/index";

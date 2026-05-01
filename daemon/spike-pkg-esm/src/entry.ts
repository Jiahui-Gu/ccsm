// Spike entry: import the (copied) generated Connect/proto stubs from
// gen/ts/ccsm/v1/ and prove that pkg can ingest, transform, and execute the
// resulting ESM graph. The gen-v1/ directory is a verbatim copy of
// gen/ts/ccsm/v1/ — see daemon/spike-pkg-esm/scripts/sync-gen.mjs.

import {
  CcsmService,
  file_ccsm_v1_core,
  file_ccsm_v1_pty,
} from "./gen-v1/index.js";

function main(): void {
  const out = {
    serviceTypeName: CcsmService.typeName,
    serviceMethodCount: Object.keys(CcsmService.method).length,
    coreFile: file_ccsm_v1_core.proto.name,
    ptyFile: file_ccsm_v1_pty.proto.name,
  };
  // eslint-disable-next-line no-console
  console.log("[spike-pkg-esm] OK", JSON.stringify(out));
}

main();

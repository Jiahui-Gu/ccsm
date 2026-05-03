// hello.js — Node 22 SEA hello-world probe entrypoint for T9.9.
//
// Tracked under spec ch10 §1 (sea pipeline contract). Pinned by Task #117.
//
// Contract: print exactly one line "hello-from-sea-<platform>" then exit 0.
// Used by build.{sh,ps1} to validate that the SEA-built binary executes.
console.log('hello-from-sea-' + process.platform);

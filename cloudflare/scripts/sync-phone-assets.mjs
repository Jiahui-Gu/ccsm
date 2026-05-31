import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const src = resolve(repoRoot, "dist", "renderer");
const dest = resolve(here, "..", "public");

for (const f of ["phone.html", "phone.js"]) {
  const from = resolve(src, f);
  if (!existsSync(from)) {
    console.error(`[sync-phone-assets] missing ${from} — run the renderer production build first (npm run build).`);
    process.exit(1);
  }
}
mkdirSync(dest, { recursive: true });
for (const f of ["phone.html", "phone.js"]) {
  cpSync(resolve(src, f), resolve(dest, f));
  console.log(`[sync-phone-assets] copied ${f}`);
}

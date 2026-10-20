import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { verifyDomainPin } from "./verify-domain-pin.ts";

verifyDomainPin(false);

const root = "node_modules/alchemy";
if (!existsSync(`${root}/package.json`)) {
  process.exit(0);
}
execFileSync("tar", ["-xzf", "vendor/alchemy-src-overlay.tgz", "-C", root]);
for (const name of ["Domain.d.ts", "Story.d.ts", "Cloudflare.d.ts"]) {
  copyFileSync(`vendor/alchemy-domain/${name}`, `${root}/${name}`);
}
const path = `${root}/package.json`;
const pkg = JSON.parse(readFileSync(path, "utf8")) as {
  exports: Record<string, string>;
};
pkg.exports["./Domain"] = "./src/Domain/index.ts";
pkg.exports["./Domain/Cloudflare"] = "./src/Domain/Cloudflare.ts";
pkg.exports["./Domain/Story"] = "./src/Domain/Story.ts";
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);

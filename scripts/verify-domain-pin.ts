import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface AlchemyPin {
  readonly archiveSha256: string;
  readonly commit: string;
  readonly overlaySha256: string;
}

const overlayPath = "vendor/alchemy-src-overlay.tgz";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const readPin = (): AlchemyPin =>
  JSON.parse(readFileSync("vendor/alchemy-pin.json", "utf8")) as AlchemyPin;

const assertHash = (actual: string, expected: string, message: string) => {
  if (actual !== expected) {
    throw new Error(message);
  }
};

const assertOverlay = (pin: AlchemyPin) => {
  assertHash(
    sha256(readFileSync(overlayPath)),
    pin.overlaySha256,
    "vendor/alchemy-src-overlay.tgz does not match alchemy-pin.json"
  );
};

const assertMembers = (
  pin: AlchemyPin,
  overlayDir: string,
  packageRoot: string
) => {
  const listed = execFileSync("tar", ["-tzf", overlayPath], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith("/"));
  for (const relative of listed) {
    const left = readFileSync(join(overlayDir, relative));
    const right = readFileSync(join(packageRoot, relative));
    if (!left.equals(right)) {
      throw new Error(`${relative} differs from commit ${pin.commit}`);
    }
  }
};

const assertUpstream = (pin: AlchemyPin) => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-pin-"));
  const archivePath = join(root, "alchemy.tar.gz");
  const url = `https://github.com/alchemy-run/alchemy/archive/${pin.commit}.tar.gz`;
  execFileSync("curl", ["-fsSL", "-o", archivePath, url]);
  assertHash(
    sha256(readFileSync(archivePath)),
    pin.archiveSha256,
    "upstream alchemy archive does not match alchemy-pin.json"
  );
  const overlayDir = join(root, "overlay");
  const archiveDir = join(root, "archive");
  execFileSync("mkdir", ["-p", overlayDir, archiveDir]);
  execFileSync("tar", ["-xzf", overlayPath, "-C", overlayDir]);
  execFileSync("tar", ["-xzf", archivePath, "-C", archiveDir]);
  assertMembers(
    pin,
    overlayDir,
    join(archiveDir, `alchemy-${pin.commit}`, "packages", "alchemy")
  );
  rmSync(root, { force: true, recursive: true });
};

export const verifyDomainPin = (upstream: boolean) => {
  const pin = readPin();
  assertOverlay(pin);
  if (upstream) {
    assertUpstream(pin);
  }
};

const invoked = (process.argv[1] ?? "").endsWith("verify-domain-pin.ts");
if (invoked) {
  try {
    verifyDomainPin(process.argv.includes("--upstream"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "pin check failed");
    process.exit(1);
  }
}

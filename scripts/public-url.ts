import { appendFileSync } from "node:fs";
import { readEnv } from "../src/boundary/external.ts";
import { publicBase } from "../src/runtime/worker-surface.ts";

const base = publicBase(
  readEnv("AGENT_ROOMS_DOMAIN"),
  readEnv("AGENT_ROOMS_URL")
);
const line = `AGENT_ROOMS_PUBLIC_URL=${base ?? ""}`;
const file = readEnv("GITHUB_ENV");
if (file !== undefined) {
  appendFileSync(file, `${line}\n`);
}

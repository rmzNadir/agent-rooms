import { spawnSync } from "node:child_process";
import { readEnv } from "../src/boundary/external.ts";
import { adoptEnabled, stageArgs } from "./stage-command.ts";

const command = readEnv("AGENT_ROOMS_ALCHEMY_COMMAND");
const stage = readEnv("ALCHEMY_STAGE");

if (command !== "deploy" && command !== "plan") {
  throw new Error("missing AGENT_ROOMS_ALCHEMY_COMMAND");
}
if (stage === undefined || stage.length === 0) {
  throw new Error("missing ALCHEMY_STAGE");
}

const result = spawnSync(
  "bunx",
  [
    "alchemy",
    ...stageArgs({
      adopt: adoptEnabled(readEnv("AGENT_ROOMS_ADOPT")),
      command,
      stage,
    }),
  ],
  { stdio: "inherit" }
);

if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === null) {
  console.error(result.signal ?? "alchemy did not exit");
  process.exit(1);
}
process.exit(result.status);

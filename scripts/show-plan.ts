import { readFileSync } from "node:fs";
import { readEnv } from "../src/boundary/external.ts";
import { redact } from "./setup-account.ts";

const secretNames = [
  "AGENT_ROOMS_ADMIN_TOKEN",
  "AGENT_ROOMS_BROBERT_TOKEN",
  "AGENT_ROOMS_BROBERT_WEBHOOK_SECRET",
  "AGENT_ROOMS_CODEX_TOKEN",
  "AGENT_ROOMS_CODEX_WEBHOOK_SECRET",
  "AGENT_ROOMS_URL",
  "AGENT_ROOMS_VERIFY_TOKENS",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
];

const text = readFileSync(0, "utf8");
process.stdout.write(
  redact(
    text,
    secretNames.flatMap((name) => {
      const value = readEnv(name);
      return value === undefined ? [] : [value];
    })
  )
);

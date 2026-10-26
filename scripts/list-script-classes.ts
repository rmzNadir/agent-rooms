import { readEnv } from "../src/boundary/external.ts";
import { pinnedScriptName } from "../src/runtime/worker-surface.ts";
import { cfFetch } from "./http-text.ts";
import { field, httpOk, readPayload, textField } from "./snapshot-diff.ts";

const account = readEnv("CLOUDFLARE_ACCOUNT_ID") ?? "";
const token = readEnv("CLOUDFLARE_API_TOKEN") ?? "";
const script = pinnedScriptName(
  readEnv("AGENT_ROOMS_URL"),
  readEnv("AGENT_ROOMS_WORKER_NAME")
);

if (script === undefined || account.length === 0 || token.length === 0) {
  console.log("pinned script missing");
  process.exit(0);
}

const reply = await cfFetch(token)(
  "GET",
  `/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(script)}/settings`
);
if (reply.status === 404) {
  console.log(`pinned script ${script} is not on the account`);
  process.exit(0);
}
if (!httpOk(reply.status)) {
  console.log(`script settings failed ${reply.status}`);
  process.exit(0);
}

const bindings = field(field(readPayload(reply.text), "result"), "bindings");
const classes = Array.isArray(bindings)
  ? bindings.flatMap((binding) => {
      if (textField(binding, "type") !== "durable_object_namespace") {
        return [];
      }
      const name = textField(binding, "class_name");
      return name === undefined ? [] : [name];
    })
  : [];
console.log(`pinned script ${script}`);
for (const name of [...new Set(classes)].sort()) {
  console.log(name);
}

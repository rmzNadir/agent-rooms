import {
  accountSubdomain,
  deleteScript,
  enableSubdomain,
  scriptPath,
} from "./cf-client.ts";
import {
  cfFetch,
  type FetchLike,
  requestHeaders,
  requireEnv,
} from "./http-text.ts";

export const RECEIVER_SOURCE = [
  "export class Wakes {",
  "  constructor(state) { this.state = state; }",
  "  async fetch(request) {",
  "    const url = new URL(request.url);",
  '    const stored = (await this.state.storage.get("wakes")) ?? [];',
  '    if (request.method === "POST" && url.pathname === "/wake") {',
  "      stored.push(await request.text());",
  '      await this.state.storage.put("wakes", stored);',
  "      return Response.json({ ok: true });",
  "    }",
  '    if (request.method === "GET" && url.pathname === "/wakes") {',
  "      return Response.json(stored);",
  "    }",
  '    return new Response("missing", { status: 404 });',
  "  }",
  "}",
  "export default {",
  "  async fetch(request, env) {",
  '    const stub = env.WAKES.get(env.WAKES.idFromName("only"));',
  "    return stub.fetch(request);",
  "  },",
  "};",
].join("\n");

export const receiverMetadata = () => ({
  bindings: [
    {
      class_name: "Wakes",
      name: "WAKES",
      type: "durable_object_namespace",
    },
  ],
  compatibility_date: "2026-08-31",
  main_module: "receiver.js",
  migrations: [{ new_classes: ["Wakes"], tag: "v1" }],
});

export const receiverName = (runId: string) => `agent-rooms-receiver-${runId}`;

export const receiverUrl = (script: string, subdomain: string) =>
  `https://${script}.${subdomain}.workers.dev`;

export const receiverForm = () => {
  const form = new FormData();
  form.set(
    "metadata",
    new File([JSON.stringify(receiverMetadata())], "metadata.json", {
      type: "application/json",
    })
  );
  form.set(
    "receiver.js",
    new File([RECEIVER_SOURCE], "receiver.js", {
      type: "application/javascript+module",
    })
  );
  return form;
};

const cfApi = "https://api.cloudflare.com/client/v4";

export const uploadScript = async (
  fetchLike: FetchLike,
  token: string,
  account: string,
  script: string
) => {
  const response = await fetchLike(
    `${cfApi}${scriptPath(account, script, "")}`,
    {
      body: receiverForm(),
      headers: requestHeaders(token, undefined),
      method: "PUT",
    }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`receiver upload failed ${response.status}`);
  }
};

const removeQuiet = async (
  call: ReturnType<typeof cfFetch>,
  account: string,
  script: string
) => {
  await deleteScript(call, account, script).catch(() => undefined);
};

export const publishReceiver = async (
  fetchLike: FetchLike,
  token: string,
  account: string,
  runId: string
) => {
  const script = receiverName(runId);
  const call = cfFetch(token);
  try {
    await uploadScript(fetchLike, token, account, script);
    await enableSubdomain(call, account, script);
    return receiverUrl(script, await accountSubdomain(call, account));
  } catch (error) {
    await removeQuiet(call, account, script);
    throw error;
  }
};

export const dropReceiver = async (
  token: string,
  account: string,
  runId: string
) => {
  await deleteScript(cfFetch(token), account, receiverName(runId));
};

const run = async (command: string | undefined) => {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const account = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const runId = requireEnv("GITHUB_RUN_ID");
  if (command === "up") {
    const url = await publishReceiver(fetch, token, account, runId);
    console.log(`receiver ${url}`);
    return;
  }
  if (command === "down") {
    await dropReceiver(token, account, runId);
    console.log(`deleted ${receiverName(runId)}`);
    return;
  }
  throw new Error("usage: up | down");
};

if (import.meta.main) {
  try {
    await run(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "receiver failed");
    process.exit(1);
  }
}

import nodePath from "node:path";
import { Effect, Schema } from "effect";
import type { Json } from "effect/Schema";
import { at, causeMessage, readEnv } from "../src/boundary/external.ts";

const usage = `Usage:
  AGENT_ROOMS_URL=https://worker AGENT_ROOMS_ADMIN_TOKEN=... bun scripts/agents.ts create --name ada [--kind agent|human] [--webhook https://listener]
  AGENT_ROOMS_URL=... AGENT_ROOMS_ADMIN_TOKEN=... bun scripts/agents.ts list
  AGENT_ROOMS_URL=... AGENT_ROOMS_ADMIN_TOKEN=... bun scripts/agents.ts rotate --id agent_...
  AGENT_ROOMS_URL=... AGENT_ROOMS_TOKEN=<agent token> bun scripts/agents.ts webhook --id agent_... --url https://listener

create prints the bearer token and webhook secret once. webhook authenticates as that agent, and --id must be that agent.
`;

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const Created = Schema.Struct({
  agent: Schema.Struct({
    admin: Schema.Boolean,
    agentId: Schema.String,
    displayName: Schema.String,
    kind: Schema.String,
  }),
  token: Schema.String,
  webhookSecret: Schema.String,
});

const decodeCreated = Schema.decodeEffect(Schema.fromJsonString(Created));

const request = (path: string, method: string, token: string, body?: Json) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      const response = await fetch(
        `${readEnv("AGENT_ROOMS_URL") ?? ""}${path}`,
        {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method,
        }
      );
      return { ok: response.ok, text: await response.text() };
    },
  }).pipe(Effect.orDie);

const requireText = (value: string | undefined, admin: string) =>
  value === undefined || admin.length === 0 ? undefined : value;

const createAgent = (admin: string) =>
  Effect.gen(function* () {
    const name = requireText(flag("--name"), admin);
    if (name === undefined) {
      return yield* Effect.die(usage);
    }
    const created = yield* request("/admin/agents", "POST", admin, {
      displayName: name,
      kind: flag("--kind") ?? "agent",
      webhookUrl: flag("--webhook") ?? null,
    });
    if (!created.ok) {
      return yield* Effect.die(created.text);
    }
    const agent = yield* Effect.catchTag(
      decodeCreated(created.text),
      "SchemaError",
      () => Effect.die(created.text)
    );
    console.log(JSON.stringify(agent, null, 2));
    console.log(
      "Store the token and webhook secret now. They are not shown again."
    );
  });

const listAgents = (admin: string) =>
  Effect.gen(function* () {
    const listed = yield* request("/admin/agents", "GET", admin);
    if (!listed.ok) {
      return yield* Effect.die(listed.text);
    }
    console.log(listed.text);
  });

const rotateAgent = (admin: string) =>
  Effect.gen(function* () {
    const id = requireText(flag("--id"), admin);
    if (id === undefined) {
      return yield* Effect.die(usage);
    }
    const rotated = yield* request(
      `/admin/agents/${id}/rotate`,
      "POST",
      admin,
      {}
    );
    if (!rotated.ok) {
      return yield* Effect.die(rotated.text);
    }
    console.log(rotated.text);
  });

export const setWebhook = () =>
  Effect.gen(function* () {
    const id = flag("--id");
    const url = flag("--url");
    const token = readEnv("AGENT_ROOMS_TOKEN") ?? "";
    if (id === undefined || url === undefined || token.length === 0) {
      return yield* Effect.die(usage);
    }
    const updated = yield* request(
      `/admin/agents/${id}/webhook`,
      "POST",
      token,
      { webhookUrl: url }
    );
    if (!updated.ok) {
      return yield* Effect.die(updated.text);
    }
    console.log(updated.text);
  });

const commands: {
  readonly [name: string]: (admin: string) => Effect.Effect<void>;
} = {
  create: createAgent,
  list: listAgents,
  rotate: rotateAgent,
  webhook: () => setWebhook(),
};

export const runAgents = Effect.gen(function* () {
  const [, , command] = process.argv;
  const root = readEnv("AGENT_ROOMS_URL") ?? "";
  const admin = readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "";
  if (root.length === 0 || command === undefined || command === "help") {
    console.log(usage);
    return;
  }
  const run = at(commands, command);
  if (run === undefined) {
    console.log(usage);
    return;
  }
  yield* run(admin);
});

const [, entry] = process.argv;
if (entry !== undefined && nodePath.basename(entry) === "agents.ts") {
  Effect.runPromise(runAgents).catch((error) => {
    console.error(error instanceof Error ? causeMessage(error) : String(error));
    process.exit(1);
  });
}

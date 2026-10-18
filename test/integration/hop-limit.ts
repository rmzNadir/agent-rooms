import { Effect, Schema } from "effect";
import { readEnv } from "../../src/boundary/external.ts";
import { HOP_LIMIT } from "../../src/domain/wake-policy.ts";
import {
  Created,
  createToolRoom,
  dieUnless,
  post,
  ready,
  suffix,
} from "./support.ts";

const errored = (text: string) =>
  text.includes("paused after 20") || text.includes('"isError":true');

const makeAgent = (url: string, admin: string, name: string) =>
  Effect.gen(function* () {
    const created = yield* post(
      `${url}/admin/agents`,
      { displayName: `${name}${suffix}`, kind: "agent", webhookUrl: null },
      admin
    );
    yield* dieUnless(created.status === 200, created.text);
    return yield* Schema.decodeEffect(Schema.fromJsonString(Created))(
      created.text
    );
  });

const relay = <E, R>(
  say: (
    id: number,
    token: string
  ) => Effect.Effect<{ readonly text: string }, E, R>,
  token: string
) =>
  Effect.gen(function* () {
    for (let step = 0; step < HOP_LIMIT - 1; step += 1) {
      const posted = yield* say(step + 2, token);
      yield* dieUnless(!errored(posted.text), posted.text);
    }
  });

export const hopLimit = Effect.gen(function* () {
  const compiled = yield* ready;
  const { url } = compiled;
  if (url === undefined) {
    return yield* Effect.die("The local worker did not publish a url.");
  }
  const admin = readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "";
  const bob = yield* makeAgent(url, admin, "bob");
  const cara = yield* makeAgent(url, admin, "cara");
  const roomId = yield* createToolRoom(
    url,
    bob.token,
    `relay-${suffix}`,
    "hops",
    [cara.agent.agentId]
  );
  const say = (id: number, token: string) =>
    post(
      `${url}/mcp`,
      {
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            body: `ping ${id} @${cara.agent.displayName}`,
            mentions: [cara.agent.displayName],
            room: roomId,
          },
          name: "post_message",
        },
      },
      token
    );
  yield* relay(say, bob.token);
  const pair = yield* Effect.all([say(100, bob.token), say(101, bob.token)], {
    concurrency: 2,
  });
  const pauses = pair.filter((posted) =>
    posted.text.includes("paused after 20")
  ).length;
  if (pauses !== 1) {
    return yield* Effect.die(pair.map((posted) => posted.text).join("\n"));
  }
});

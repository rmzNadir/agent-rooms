import { createServer, type Server } from "node:http";
import { Effect, Schema } from "effect";
import type { WakeCall } from "../../listeners/listener-io.mjs";
import { readEnv } from "../../src/boundary/external.ts";
import {
  Created,
  createToolRoom,
  defined,
  dieUnless,
  observedWake,
  post,
  ready,
  suffix,
} from "./support.ts";

const openReceiver = (wakes: WakeCall[]) =>
  Effect.promise(
    () =>
      new Promise<Server>((resolve) => {
        const receiver = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            wakes.push(observedWake(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":true}');
          });
        });
        receiver.listen(0, "127.0.0.1", () => resolve(receiver));
      })
  );

const boundPort = (server: Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    return;
  }
  return address.port;
};

const agentOk = (status: number) => status === 200;

const openedAtZero = (wake: WakeCall) =>
  wake.fromSeq === 0 && wake.sinceCursor === wake.fromSeq;

const seqOf = (wake: WakeCall) =>
  typeof wake.toSeq === "number" && wake.toSeq >= 1 ? wake.toSeq : undefined;

const hasDelivery = (wake: WakeCall) =>
  typeof wake.deliveryId === "string" && wake.deliveryId.startsWith("dlv_");

const continues = (wake: WakeCall | undefined, fromSeq: number) =>
  wake !== undefined && wake.fromSeq === fromSeq;

const waitFor = (wakes: WakeCall[], count: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000;
    while (wakes.length < count && Date.now() < deadline) {
      yield* Effect.sleep("200 millis");
    }
    yield* dieUnless(
      wakes.length >= count,
      `expected ${count} wakes, saw ${JSON.stringify(wakes)}`
    );
  });

const createAgent = (
  url: string,
  admin: string,
  name: string,
  webhookUrl: string | null
) =>
  Effect.gen(function* () {
    const created = yield* post(
      `${url}/admin/agents`,
      { displayName: `${name}${suffix}`, kind: "agent", webhookUrl },
      admin
    );
    yield* dieUnless(agentOk(created.status), created.text);
    return yield* Schema.decodeEffect(Schema.fromJsonString(Created))(
      created.text
    );
  });

export const wakeRange = Effect.gen(function* () {
  const compiled = yield* ready;
  const { url } = compiled;
  if (url === undefined) {
    return yield* Effect.die("The local worker did not publish a url.");
  }
  const wakes: WakeCall[] = [];
  const server = yield* openReceiver(wakes);
  const port = yield* defined(
    boundPort(server),
    "The webhook receiver did not bind."
  );
  const admin = readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "";
  const hook = yield* createAgent(
    url,
    admin,
    "hook",
    `http://127.0.0.1:${port}/wake`
  );
  const poster = yield* createAgent(url, admin, "page", null);
  const roomId = yield* createToolRoom(
    url,
    poster.token,
    `wake-${suffix}`,
    "delivery",
    [hook.agent.agentId]
  );
  const say = (id: number, body: string) =>
    post(
      `${url}/mcp`,
      {
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            body,
            mentions: [hook.agent.displayName],
            room: roomId,
          },
          name: "post_message",
        },
      },
      poster.token
    );
  const firstPost = yield* say(2, `one @${hook.agent.displayName}`);
  yield* dieUnless(!firstPost.text.includes('"isError":true'), firstPost.text);
  yield* waitFor(wakes, 1);
  const first = yield* defined(wakes[0], "missing first wake");
  yield* dieUnless(openedAtZero(first), JSON.stringify(first));
  const toSeq = yield* defined(seqOf(first), JSON.stringify(first));
  yield* dieUnless(hasDelivery(first), JSON.stringify(first));
  const secondPost = yield* say(3, `two @${hook.agent.displayName}`);
  yield* dieUnless(
    !secondPost.text.includes('"isError":true'),
    secondPost.text
  );
  yield* waitFor(wakes, 2);
  const [, second] = wakes;
  yield* dieUnless(continues(second, toSeq), JSON.stringify(wakes));
  server.close();
});

import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Actor } from "../src/domain/actor.ts";
import { AgentId, internalRequestId, RoomId } from "../src/domain/ids.ts";
import {
  InitMember,
  InitRoomPayload,
  PostPayload,
} from "../src/room/room-http-api.ts";
import { initRoom } from "../src/room/room-membership.ts";
import { postMessage } from "../src/room/room-post.ts";
import { migrateRoom, roomQuery } from "../src/room/room-sql.ts";
import { bindWake } from "../src/room/room-wake.ts";
import { closeServer, listenLoopback, postedBodies } from "./loopback.ts";
import { callbackRuntime, openState } from "./sqlite-state.ts";

const requestId = internalRequestId;
const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);
const humanId = Schema.decodeUnknownSync(AgentId)(
  "agent_aaaaaaaaaaaaaaaaaaaaaaaa"
);
const adaId = Schema.decodeUnknownSync(AgentId)(
  "agent_bbbbbbbbbbbbbbbbbbbbbbbb"
);

const wakeOnce = async (status: number) => {
  const { bodies, server } = postedBodies(status);
  const port = await listenLoopback(server);
  let deliver:
    | ((payload: { readonly agentId: string }) => Effect.Effect<void>)
    | undefined;
  const room = openState(
    roomId,
    callbackRuntime((handler) => {
      deliver = handler;
    })
  );
  await room(migrateRoom);
  await room(
    initRoom(
      new InitRoomPayload({
        leadId: humanId,
        members: [
          new InitMember({
            agentId: humanId,
            displayName: "human",
            kind: "human",
            role: "lead",
            webhookSecret: null,
            webhookUrl: null,
          }),
          new InitMember({
            agentId: adaId,
            displayName: "ada",
            kind: "agent",
            role: "member",
            webhookSecret: "secret",
            webhookUrl: `http://127.0.0.1:${port}/hook`,
          }),
        ],
        name: "ops",
        requestId,
        roomId,
        topic: "delivery",
      })
    )
  );
  const bound = await room(bindWake({ callback: undefined }));
  const human = new Actor({
    admin: true,
    agentId: humanId,
    displayName: "human",
    kind: "human",
  });
  await room(
    postMessage(
      bound.enqueue,
      () => Effect.void
    )(
      new PostPayload({
        actor: human,
        body: "hello @ada",
        mentions: ["ada"],
        replyTo: null,
        requestId,
        threadRoot: null,
      })
    )
  );
  await room(roomQuery(requestId, "UPDATE wake_outbox SET not_before = 0"));
  if (deliver === undefined) {
    throw new Error("bindWake did not register a callback.");
  }
  await room(deliver({ agentId: adaId }));
  await closeServer(server);
  const [body] = bodies;
  const outbox = await room(
    roomQuery(requestId, "SELECT agent_id, attempts FROM wake_outbox")
  );
  return { body, outbox };
};

test("a delivered wake posts the seq range and clears the outbox", async () => {
  const delivered = await wakeOnce(200);
  expect(delivered.body).toContain(`"roomId":"${roomId}"`);
  expect(delivered.body).toContain('"toSeq":1');
  expect(delivered.outbox).toEqual([]);
});

test("a failed wake keeps the outbox and counts the attempt", async () => {
  const failed = await wakeOnce(500);
  expect(failed.body).toContain('"toSeq":1');
  expect(failed.outbox.map((row) => [row.agent_id, row.attempts])).toEqual([
    [adaId, 1],
  ]);
});

test("a busy listener keeps the wake without counting a failure", async () => {
  const busy = await wakeOnce(202);
  expect(busy.body).toContain('"toSeq":1');
  expect(busy.outbox.map((row) => [row.agent_id, row.attempts])).toEqual([
    [adaId, 0],
  ]);
});

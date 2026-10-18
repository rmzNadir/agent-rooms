import { expect, test } from "bun:test";
import { Cause, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Chat } from "../src/app/chat.ts";
import {
  audit,
  authenticateIdFailed,
  badDisplay,
  badName,
  byText,
  createAgentIdFailed,
  createRoomIdFailed,
  denied,
  duplicateName,
  idFailed,
  orSchema,
  unrecognized,
} from "../src/app/chat-support.ts";
import {
  bodyLimit,
  emojiOf,
  limitOf,
  queryOf,
  sinceOf,
  webhookOf,
} from "../src/app/limits.ts";
import { mapRejection } from "../src/app/map-error.ts";
import {
  messagePage,
  searchPage,
  threadList,
  toMessageView,
  unreadCount,
} from "../src/app/pages.ts";
import { Ack, CreatedAgent, TranscriptResult } from "../src/app/records.ts";
import {
  causeMessage,
  fillEnv,
  isJsonObject,
  readEnv,
  setAt,
  writeEnv,
} from "../src/boundary/external.ts";
import { internalRequestId, RoomId } from "../src/domain/ids.ts";
import {
  importSigningKey,
  rejectExtractable,
  signingKeyDefect,
} from "../src/domain/token.ts";
import {
  deliveryIdFor,
  earlierSeq,
  wakePayload,
} from "../src/domain/wake-body.ts";
import { pauseNotice } from "../src/domain/wake-policy.ts";
import { webhookUrlProblem } from "../src/domain/webhook-url.ts";
import {
  importPlan,
  LegacyDirectorySchema,
  plannedRoom,
} from "../src/model/migrate.ts";
import { applyOpened } from "../src/model/room-evolve.ts";
import { initialRoom } from "../src/model/room-shape.ts";
import { CredentialBook, LegacyImport } from "../src/runtime/credentials.ts";
import { RoomSockets, socketsSkip } from "../src/runtime/sockets.ts";
import { viewerHtml } from "../src/viewer/page.ts";
import { fulfill } from "./effect-run.ts";
import { leadId, message } from "./model-fixture.ts";

const requestId = internalRequestId;
const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);

const input = {
  agentId: undefined,
  operation: "post_message",
  requestId,
  roomId: undefined,
  seq: undefined,
  verb: "edit" as const,
};

test("wake ids, cursors, and the pause notice stay fixed", () => {
  expect(deliveryIdFor(1, "agent_bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(
    "dlv_a5ab742e00000001"
  );
  expect(deliveryIdFor(1, "agent_cccccccccccccccccccccccc")).toBe(
    "dlv_a30c36c600000001"
  );
  expect(earlierSeq([1, 2, 3], 4)).toBe(3);
  expect(earlierSeq([4], 4)).toBe(0);
  expect(earlierSeq([1, 5], 4)).toBe(1);
  expect(earlierSeq([], 3)).toBe(0);
  expect(
    wakePayload({
      agentId: "a",
      deliveryId: "d",
      fromSeq: 0,
      hopCount: 1,
      paused: false,
      roomId: "r",
      roomName: "n",
      toSeq: 1,
      youAreLead: true,
    })
  ).toBe(
    '{"agentId":"a","deliveryId":"d","fromSeq":0,"hopCount":1,"paused":false,"roomId":"r","roomName":"n","sinceCursor":0,"toSeq":1,"triggeringMessageIds":["1"],"youAreLead":true}'
  );
  expect(pauseNotice).toBe(
    "@human Agent-to-agent wakes are paused after 20 hops with no human message. Post in this room to resume."
  );
});

test("service keys and a non-extractable signing key stay put", async () => {
  expect(CredentialBook.key).toBe("@agent-rooms/CredentialBook");
  expect(LegacyImport.key).toBe("@agent-rooms/LegacyImport");
  expect(Chat.key).toBe("@agent-rooms/Chat");
  expect(RoomSockets.key).toBe("@agent-rooms/RoomSockets");
  const locked = await importSigningKey("secret", false);
  const opened = await importSigningKey("secret", true);
  expect(locked.extractable).toBe(false);
  expect(opened.extractable).toBe(true);
  await fulfill(rejectExtractable(locked));
  const exit = await fulfill(Effect.exit(rejectExtractable(opened)));
  expect(exit._tag).toBe("Failure");
  expect(signingKeyDefect).toBe("signing key must stay non-extractable");
  if (exit._tag === "Failure") {
    const defect = Cause.squash(exit.cause);
    expect(defect).toBeInstanceOf(Error);
    if (defect instanceof Error) {
      expect(defect.message).toBe(signingKeyDefect);
    }
  }
});

test("webhook urls reject a missing value and allow a short hostname", () => {
  expect(webhookUrlProblem("https://10.example")).toBeUndefined();
  expect(webhookUrlProblem("https://example.com/hook")).toBeUndefined();
  expect(() => webhookUrlProblem(null as never)).toThrow();
});

test("the viewer escapes markup in the room id", () => {
  expect(viewerHtml(`a&b<c>d"e`)).toContain("a&amp;b&lt;c&gt;d&quot;e");
  expect(viewerHtml(null)).toContain('data-room=""');
});

test("environment fill, json objects, and causes keep their branches", () => {
  const name = "AGENT_ROOMS_KILL_FILL";
  Reflect.deleteProperty(process.env, name);
  fillEnv(name, "one");
  expect(readEnv(name)).toBe("one");
  fillEnv(name, "two");
  expect(readEnv(name)).toBe("one");
  writeEnv(name, "three");
  expect(readEnv(name)).toBe("three");
  Reflect.deleteProperty(process.env, name);
  expect(isJsonObject("a")).toBe(false);
  expect(isJsonObject(null)).toBe(false);
  expect(isJsonObject(["a"])).toBe(false);
  expect(isJsonObject({ a: 1 })).toBe(true);
  const row: { [column: string]: number } = { a: 1 };
  setAt(row, "b", 2);
  expect(row).toEqual({ a: 1, b: 2 });
  expect(causeMessage(new Error("boom"))).toBe("boom");
  expect(causeMessage("plain")).toBe("plain");
});

test("the skipped room socket names its refusal", async () => {
  const response = await fulfill(
    Effect.gen(function* () {
      const sockets = yield* RoomSockets;
      return yield* sockets.open(
        "room_aaaaaaaaaaaaaaaaaaaaaaaa",
        HttpServerRequest.fromWeb(new Request("https://example.com/"))
      );
    }).pipe(Effect.provide(socketsSkip))
  );
  const web = HttpServerResponse.toWeb(response);
  expect(web.status).toBe(400);
  expect(await web.text()).toBe(
    "Open the room socket with a websocket upgrade."
  );
});

test("an empty import plan throws and a real one keeps the hop", () => {
  expect(() => plannedRoom([])).toThrow("The room import plan was empty.");
  const planned = plannedRoom([{ hopCount: 4 }]);
  expect(planned.hopCount).toBe(4);
  const opened = applyOpened(initialRoom, {
    hopCount: 4,
    leadId,
    members: [],
    name: "ops",
    topic: "ship",
  });
  expect(opened.hopCount).toBe(4);
  expect(
    applyOpened(initialRoom, {
      leadId,
      members: [],
      name: "ops",
      topic: "ship",
    }).hopCount
  ).toBe(0);
});

test("import keeps a reaction and directory schemas reject a hole", () => {
  const plan = importPlan({
    agents: [],
    rooms: [
      {
        hopCount: 1,
        leadId,
        members: [],
        messages: [
          {
            authorId: leadId,
            authorKind: "agent",
            authorName: "Lead",
            body: "kept",
            createdAt: 1,
            mentions: [],
            reactions: [{ agentId: leadId, emoji: "eyes" }],
            redacted: false,
            replyTo: null,
            seq: 1,
            threadRoot: null,
          },
        ],
        name: "ops",
        paused: false,
        roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaa",
        topic: "ship",
      },
    ],
  });
  expect(JSON.stringify(plan.rooms[0]?.events)).toContain("eyes");
  expect(() => Schema.decodeUnknownSync(LegacyDirectorySchema)({})).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(LegacyDirectorySchema)({
      agents: [
        { agentId: leadId, displayName: "Lead", kind: "", tokenHash: "h" },
      ],
      rooms: [],
    })
  ).toThrow();
});

test("record schemas reject a missing field", () => {
  expect(Ack.identifier).toBe("Ack");
  expect(CreatedAgent.identifier).toBe("CreatedAgent");
  expect(TranscriptResult.identifier).toBe("TranscriptResult");
  expect(() => Schema.decodeUnknownSync(Ack)({})).toThrow();
  expect(() => Schema.decodeUnknownSync(CreatedAgent)({})).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(TranscriptResult)({ format: "" })
  ).toThrow();
  expect(new Ack({ ok: true }).ok).toBe(true);
});

const failText = <A, E>(effect: Effect.Effect<A, E>) =>
  fulfill(
    effect.pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => {
          throw new Error("expected failure");
        },
      })
    )
  );

test("limits reject the boundary that sits just outside the rule", async () => {
  expect(
    await fulfill(bodyLimit(requestId, "post_message", "ok"))
  ).toBeUndefined();
  expect(await fulfill(limitOf(requestId, "read_messages", 1))).toBe(1);
  expect(await fulfill(limitOf(requestId, "read_messages", 200))).toBe(200);
  expect(await fulfill(sinceOf(requestId, "read_messages", 0))).toBe(0);
  expect(await fulfill(emojiOf(requestId, "ok"))).toBe("ok");
  expect(await fulfill(queryOf(requestId, " alpha "))).toBe(" alpha ");
  const emptyBody = await failText(bodyLimit(requestId, "post_message", "   "));
  const longBody = await failText(
    bodyLimit(requestId, "post_message", "x".repeat(8001))
  );
  const exact = await fulfill(
    bodyLimit(requestId, "post_message", "x".repeat(8000))
  );
  const lowLimit = await failText(limitOf(requestId, "read_messages", 0));
  const highLimit = await failText(limitOf(requestId, "read_messages", 201));
  const badSince = await failText(sinceOf(requestId, "read_messages", -1));
  const badEmoji = await failText(emojiOf(requestId, "no pe"));
  const blankQuery = await failText(queryOf(requestId, "   "));
  expect(exact).toBeUndefined();
  expect(emptyBody.message).toBe(
    "body must be 1 to 8000 characters. Correct it and retry."
  );
  expect(longBody.message).toContain("body must be 1 to 8000 characters");
  expect(lowLimit.details).toEqual({
    constraint: "must be an integer from 1 to 200",
    field: "limit",
  });
  expect(highLimit.message).toContain("limit must be an integer from 1 to 200");
  expect(badSince.message).toBe(
    "since must be a non-negative integer. Correct it and retry."
  );
  expect(badEmoji.message).toContain(
    "emoji must be 1 to 16 characters without spaces"
  );
  expect(blankQuery.message).toBe(
    "query must not be empty. Correct it and retry."
  );
  const blocked = await failText(
    webhookOf(requestId, "register_webhook", "https://10.1.2.3/hook")
  );
  expect(blocked.details).toEqual({
    constraint: "must not target a private or link-local address",
    field: "webhookUrl",
  });
  expect(
    await fulfill(webhookOf(requestId, "register_webhook", null))
  ).toBeUndefined();
});

test("pages keep ids, threads, search hits, and unread counts", () => {
  const root = { ...message(1, leadId, "y".repeat(200)), threadRoot: null };
  const reply = { ...message(2, leadId, "hello"), threadRoot: 1 };
  const tail = { ...message(6, leadId, "tail"), threadRoot: 1 };
  const other = { ...message(3, leadId, "nope"), threadRoot: 9 };
  const page = messagePage([root, reply, tail, other], 0, 3, 1);
  expect(page.messages.map((item) => item.seq)).toEqual([1, 2, 6]);
  expect(page.nextCursor).toBe(6);
  expect(page.messages[0]?.id).toBe("msg_0000000000000001");
  expect(page.messages[0]?.editedAt).toBeNull();
  expect(messagePage([], 0, 10, null).nextCursor).toBeNull();
  const threads = threadList([root, reply, tail, other], 1);
  expect(threads.length).toBe(1);
  expect(threads[0]?.lastSeq).toBe(6);
  expect(threads[0]?.preview.length).toBe(180);
  expect(threads[0]?.replies).toBe(2);
  expect(threads[0]?.rootSeq).toBe(1);
  const later = { ...message(4, leadId, "later"), threadRoot: null };
  const ordered = threadList([root, later], 2);
  expect(ordered.map((item) => item.rootSeq)).toEqual([4, 1]);
  expect(threadList([root, later], 1).map((item) => item.rootSeq)).toEqual([4]);
  const found = searchPage([root, reply], "hello", 10);
  expect(found.messages.map((item) => item.seq)).toEqual([2]);
  expect(found.nextCursor).toBe(2);
  expect(unreadCount([root, reply], 0, leadId)).toBe(0);
  expect(unreadCount([root, reply], 0, "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
    2
  );
  expect(unreadCount([root, reply], 1, "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
    1
  );
  expect(
    toMessageView({
      ...root,
      mentions: ["Sam"],
      reactions: [{ agentId: leadId, emoji: "eyes" }],
    }).reactions
  ).toEqual([{ agentId: leadId, emoji: "eyes" }]);
});

test("mapped errors keep every public field", async () => {
  const missing = mapRejection(
    { _tag: "MessageNotFound" },
    { ...input, roomId, seq: 5 }
  );
  expect(missing.message).toBe(`Message 5 was not found in room ${roomId}.`);
  expect(missing.operation).toBe("message.read");
  const zero = mapRejection({ _tag: "MessageNotFound" }, input);
  expect(zero.message).toContain("room_000000000000000000000000");
  expect(zero.details).toEqual({
    roomId: "room_000000000000000000000000",
    seq: 0,
  });
  const unknown = mapRejection(
    { _tag: "UnknownMention", token: "ada" },
    { ...input, roomId }
  );
  expect(unknown.message).toBe(
    `@ada is not a member of room ${roomId}. Use a display name, @all, or @human.`
  );
  expect(unknown.details).toEqual({ roomId, token: "ada" });
  const blankToken = mapRejection({ _tag: "UnknownMention" }, input);
  expect(blankToken.message.startsWith("@ is not a member")).toBe(true);
  expect(blankToken.details).toEqual({
    roomId: "room_000000000000000000000000",
    token: "",
  });
  const taken = mapRejection({ _tag: "RoomNameTaken", name: "ops" }, input);
  expect(taken.message).toBe(
    "A room named ops already exists. Choose a different name."
  );
  const nameless = mapRejection({ _tag: "RoomNameTaken" }, input);
  expect(nameless.message).toBe(
    "A room named  already exists. Choose a different name."
  );
  const agent = mapRejection(
    { _tag: "AgentMissing" },
    { ...input, agentId: leadId }
  );
  expect(agent.message).toBe(
    `Agent ${leadId} was not found. Check the id and retry.`
  );
  expect(agent.code).toBe("AgentNotFound");
  expect(agent.operation).toBe("agent.read");
  expect(agent.retryable).toBe(false);
  const missingAgent = mapRejection({ _tag: "AgentMissing" }, input);
  expect(missingAgent.message).toContain("agent_000000000000000000000000");
  const duplicate = mapRejection({ _tag: "AgentAlreadyRegistered" }, input);
  expect(duplicate.message).toBe(
    "That agent is already registered. Choose a different id."
  );
  expect(duplicate.operation).toBe("create_agent");
  expect(duplicate.details).toEqual({
    constraint: "must be unique",
    field: "agentId",
  });
  const saved = mapRejection(
    { _tag: "AlreadyOpen" },
    { ...input, operation: "create_room" }
  );
  expect(saved.message).toBe(
    "The room could not save that change. Retry the same request."
  );
  expect(saved.retryable).toBe(true);
  expect(saved.operation).toBe("create_room");
  const stray = mapRejection({ _tag: "NotARealTag" }, input);
  expect(stray.code).toBe("PersistenceFailed");
  const only = mapRejection({ _tag: "OnlyMember" }, { ...input, roomId });
  expect(only.message).toBe(
    `You are the only member of room ${roomId}. Invite someone else before leaving.`
  );
  expect(byText("a", "b")).toBe(-1);
  expect(byText("b", "a")).toBe(1);
  expect(byText("a", "a")).toBe(0);
  expect(denied(requestId, "list_agents").message).toBe(
    "That action is limited to the admin human. Use an admin token and retry."
  );
  expect(badName(requestId).message).toBe(
    "name must be a short room name. Correct it and retry."
  );
  expect(badName(requestId).details).toEqual({
    constraint: "see the README for the accepted pattern",
    field: "name",
  });
  expect(badDisplay(requestId).message).toBe(
    "Display name must be one mention token, such as ada or coordinator."
  );
  expect(duplicateName(requestId, "ada").message).toBe(
    "An agent named ada already exists. Choose a different display name."
  );
  expect(unrecognized(requestId).message).toBe(
    "The bearer token was not recognized. Check the token and retry."
  );
  expect(unrecognized(requestId).operation).toBe(audit);
  expect(idFailed("create_agent").message).toBe(
    "A new id could not be minted. Retry the same request."
  );
  const minted = await fulfill(
    orSchema(Effect.succeed("agent"), createAgentIdFailed())
  );
  expect(minted).toBe("agent");
  const agentMint = await fulfill(
    Effect.flip(
      orSchema(
        Effect.fail({ _tag: "SchemaError" as const }),
        createAgentIdFailed()
      )
    )
  );
  expect(agentMint.operation).toBe("create_agent");
  expect(agentMint.retryable).toBe(true);
  const roomMint = await fulfill(Effect.flip(createRoomIdFailed()));
  expect(roomMint.operation).toBe("create_room");
  const authMint = await fulfill(Effect.flip(authenticateIdFailed()));
  expect(authMint.operation).toBe("authenticate");
  expect(idFailed("create_agent").retryable).toBe(true);
  expect(idFailed("create_agent").requestId).toBe(requestId);
});

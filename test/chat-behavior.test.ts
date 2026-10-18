import { expect, test } from "bun:test";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { Chat } from "../src/app/chat.ts";
import { hashToken } from "../src/domain/token.ts";
import { callTool } from "../src/mcp/call-tool.ts";
import {
  chatRunner,
  createPerson,
  invitePerson,
  requestId,
  resolveAdmin,
} from "./live-chat.ts";
import { startHost } from "./object-host.ts";

const { failure, run } = chatRunner(await startHost());

test("chat drives directory and room behavior through the live handlers", async () => {
  const adminHash = await Effect.runPromise(hashToken("admin-token"));
  const admin = await resolveAdmin(run);
  expect(admin).toMatchObject({
    admin: true,
    displayName: "human",
    kind: "human",
  });
  const { actor: ada, created } = await createPerson(
    run,
    admin,
    "ada",
    "agent"
  );
  expect(created.agent.displayName).toBe("ada");
  expect(created.agent.kind).toBe("agent");
  const missingLead = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [],
        name: "solo",
        requestId,
        topic: "none",
      });
    })
  );
  expect(missingLead).toMatchObject({
    _tag: "LeadRequired",
    operation: "create_room",
  });
  const badName = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [ada.agentId],
        name: "bad name!",
        requestId,
        topic: "none",
      });
    })
  );
  expect(badName).toMatchObject({
    _tag: "InvalidArgument",
    operation: "create_room",
  });
  const room = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [ada.agentId],
        name: "ops",
        requestId,
        topic: "delivery",
      });
    })
  );
  expect(room.name).toBe("ops");
  expect(room.topic).toBe("delivery");
  const taken = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [ada.agentId],
        name: "ops",
        requestId,
        topic: "again",
      });
    })
  );
  expect(taken).toMatchObject({ _tag: "RoomNameTaken" });
  const agents = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.listAgents(admin, requestId);
    })
  );
  expect(agents.map((agent) => agent.displayName).sort()).toEqual([
    "ada",
    "human",
  ]);
  const rooms = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.listRooms(admin, requestId);
    })
  );
  expect(rooms.map((item) => item.name)).toEqual(["ops"]);
  const posted = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "hello @human",
        mentions: ["human"],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  const [message] = posted.messages;
  expect(message?.body).toBe("hello @human");
  expect(message?.seq).toBe(1);
  const unread = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.getUnread(admin, requestId, room.roomId);
    })
  );
  expect(unread.unread).toBe(1);
  expect(unread.latestSeq).toBe(1);
  const read = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.readMessages({
        actor: admin,
        limit: 10,
        requestId,
        roomId: room.roomId,
        since: 0,
        thread: null,
      });
    })
  );
  expect(read.messages.map((item) => item.body)).toEqual(["hello @human"]);
  const edited = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.editMessage(
        ada,
        requestId,
        room.roomId,
        1,
        "hello @human again",
        ["human"]
      );
    })
  );
  expect(edited.body).toBe("hello @human again");
  const found = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.searchMessages(
        admin,
        requestId,
        room.roomId,
        "again",
        10
      );
    })
  );
  expect(found.messages.map((item) => item.seq)).toEqual([1]);
  const reacted = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.react(admin, requestId, room.roomId, 1, "👀");
    })
  );
  expect(reacted.reactions).toEqual([{ agentId: admin.agentId, emoji: "👀" }]);
  const transcript = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.readTranscript({
        actor: admin,
        format: "json",
        limit: 10,
        requestId,
        roomId: room.roomId,
        since: 0,
        thread: null,
      });
    })
  );
  expect(transcript.format).toBe("json");
  expect(transcript.text.includes("hello @human again")).toBe(true);
  const threads = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.listThreads(admin, requestId, room.roomId, 10);
    })
  );
  expect(threads.threads.length).toBeGreaterThan(0);
  const marked = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.markRead(admin, requestId, room.roomId, 1);
    })
  );
  expect(marked.unread).toBe(0);
  expect(marked.lastReadSeq).toBe(1);
  const waited = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.waitForMessages(
        admin,
        requestId,
        room.roomId,
        0,
        10,
        0
      );
    })
  );
  expect(waited.messages.length).toBeGreaterThan(0);
  const who = await run(
    Effect.gen(function* () {
      return yield* callTool(admin, "whoami", {}, requestId);
    })
  );
  expect(who.isError).toBe(false);
  expect(who.content[0]?.text.includes('"displayName"')).toBe(true);
  const members = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.members(admin, requestId, room.roomId);
    })
  );
  expect(members.members.map((member) => member.displayName).sort()).toEqual([
    "ada",
    "human",
  ]);
  const { actor: bob } = await createPerson(run, admin, "bob", "human");
  const invited = await invitePerson(run, admin, room.roomId, bob.agentId);
  expect(invited.joined).toBe(false);
  const joined = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.join(bob, requestId, room.roomId);
    })
  );
  expect(joined.joined).toBe(true);
  const rotated = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.rotateToken(admin, requestId, ada.agentId);
    })
  );
  expect(rotated.token).not.toBe(created.token);
  const webhook = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.registerWebhook(
        ada,
        requestId,
        "https://listener.example/hook"
      );
    })
  );
  expect(webhook.webhookUrl).toBe("https://listener.example/hook");
  const toolCalls: ReadonlyArray<readonly [string, object]> = [
    ["list_rooms", {}],
    ["members", { room: room.roomId }],
    ["get_unread", { room: room.roomId }],
    ["read_messages", { limit: 10, room: room.roomId, since: 0 }],
    ["list_threads", { limit: 10, room: room.roomId }],
    ["read_transcript", { format: "markdown", room: room.roomId }],
    ["search_messages", { query: "again", room: room.roomId }],
    ["wait_for_messages", { room: room.roomId, timeout_ms: 0 }],
    ["whoami", {}],
  ];
  const called = await run(
    Effect.gen(function* () {
      const results: { readonly isError: boolean }[] = [];
      for (const [name, args] of toolCalls) {
        results.push(yield* callTool(admin, name, args, requestId));
      }
      return results;
    })
  );
  for (const result of called) {
    expect(result.isError).toBe(false);
  }
  const missingRoom = await failure(
    Effect.gen(function* () {
      return yield* callTool(admin, "members", {}, requestId);
    })
  );
  expect(missingRoom).toMatchObject({
    _tag: "InvalidArgument",
    operation: "tools/call",
  });
  const forwarded = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.forward(
        room.roomId,
        HttpServerRequest.fromWeb(
          new Request("http://room.internal/v1/members", {
            body: JSON.stringify({ actor: admin, requestId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        ),
        requestId
      );
    })
  );
  expect(forwarded.status).toBe(200);
  const unknownTool = await run(
    Effect.gen(function* () {
      return yield* callTool(admin, "not_a_tool", {}, requestId);
    })
  );
  expect(unknownTool.isError).toBe(true);
  expect(unknownTool.content[0]?.text.includes("not a tool")).toBe(true);
  const redacted = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.redactMessage(ada, requestId, room.roomId, 1);
    })
  );
  expect(redacted.redacted).toBe(true);
  const bobLeft = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.leave(bob, requestId, room.roomId);
    })
  );
  expect(bobLeft.ok).toBe(true);
  const left = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.leave(ada, requestId, room.roomId);
    })
  );
  expect(left.ok).toBe(true);
  const solo = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.leave(admin, requestId, room.roomId);
    })
  );
  expect(solo).toMatchObject({ _tag: "Forbidden", operation: "leave" });
  const notAdmin = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createAgent(ada, requestId, "cara", "agent", null);
    })
  );
  expect(notAdmin).toMatchObject({
    _tag: "Forbidden",
    operation: "create_agent",
  });
  const duplicate = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createAgent(admin, requestId, "ada", "agent", null);
    })
  );
  expect(duplicate).toMatchObject({
    _tag: "InvalidArgument",
    message:
      "An agent named ada already exists. Choose a different display name.",
    operation: "create_agent",
  });
  const badDisplay = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createAgent(admin, requestId, "1bad", "agent", null);
    })
  );
  expect(badDisplay).toMatchObject({
    _tag: "InvalidArgument",
    operation: "create_agent",
  });
  const hidden = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.listAgents(ada, requestId);
    })
  );
  expect(hidden).toMatchObject({ _tag: "Forbidden", operation: "list_agents" });
  const stolen = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.rotateToken(ada, requestId, admin.agentId);
    })
  );
  expect(stolen).toMatchObject({
    _tag: "Forbidden",
    operation: "rotate_token",
  });
  const stranger = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.resolve("not-a-token", adminHash, "human");
    })
  );
  expect(stranger).toMatchObject({
    _tag: "Unauthorized",
    operation: "authenticate",
  });
  const badHook = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.registerWebhook(admin, requestId, "not a url");
    })
  );
  expect(badHook).toMatchObject({ _tag: "InvalidArgument" });
});

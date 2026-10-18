import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Chat } from "../src/app/chat.ts";
import { systemAgentId } from "../src/domain/ids.ts";
import {
  chatRunner,
  createPerson,
  invitePerson,
  requestId,
  resolveAdmin,
} from "./live-chat.ts";
import { startHost } from "./object-host.ts";

const { failure, run } = chatRunner(await startHost());

test("room rules reject the post, membership, and edit that break them", async () => {
  const admin = await resolveAdmin(run);
  const { actor: ada } = await createPerson(run, admin, "ada", "agent");
  const room = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [ada.agentId],
        name: "rules",
        requestId,
        topic: "limits",
      });
    })
  );
  const humanPost = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: admin,
        body: "status",
        mentions: [],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(humanPost.messages[0]?.mentions).toEqual(["all"]);
  const untagged = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "ping",
        mentions: [],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(untagged).toMatchObject({
    _tag: "MentionRequired",
    code: "MentionRequired",
    message: `Message in room ${room.roomId} was not posted. Agents must @mention a member, @all, or @human.`,
    operation: "post_message",
    retryable: false,
  });
  const missing = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "hello @nobody",
        mentions: ["nobody"],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(missing).toMatchObject({
    _tag: "UnknownMention",
    code: "UnknownMention",
    message: `@nobody is not a member of room ${room.roomId}. Use a display name, @all, or @human.`,
    operation: "post_message",
    retryable: false,
  });
  const selfOnly = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "hello @ada",
        mentions: ["ada"],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(selfOnly).toMatchObject({
    _tag: "SelfMentionOnly",
    code: "SelfMentionOnly",
    message: `Message in room ${room.roomId} only mentioned you. Mention someone else; posts do not wake their author.`,
    operation: "post_message",
    retryable: false,
  });
  const missingReply = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "hello @human",
        mentions: ["human"],
        replyTo: 99,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(missingReply).toMatchObject({
    _tag: "MessageNotFound",
    code: "MessageNotFound",
    message: `Message 99 was not found in room ${room.roomId}.`,
    operation: "message.read",
    retryable: false,
  });
  const posted = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "hello @human",
        mentions: ["human"],
        replyTo: 1,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(posted.messages[0]?.threadRoot).toBe(1);
  expect(posted.messages[0]?.seq).toBe(2);
  const notAuthor = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.editMessage(
        admin,
        requestId,
        room.roomId,
        2,
        "hello @ada",
        ["ada"]
      );
    })
  );
  expect(notAuthor).toMatchObject({
    _tag: "NotAuthor",
    message:
      "Message 2 belongs to someone else. You can edit only your own messages.",
    operation: "message.mutate",
    retryable: false,
  });
  const blank = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.editMessage(ada, requestId, room.roomId, 2, " ", []);
    })
  );
  expect(blank).toMatchObject({
    _tag: "InvalidArgument",
    message: "body must be 1 to 8000 characters. Correct it and retry.",
    operation: "edit_message",
  });
  const missingEdit = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.editMessage(
        ada,
        requestId,
        room.roomId,
        50,
        "hello @human",
        ["human"]
      );
    })
  );
  expect(missingEdit).toMatchObject({
    _tag: "MessageNotFound",
    message: `Message 50 was not found in room ${room.roomId}.`,
  });
  const { actor: bob } = await createPerson(run, admin, "bob", "human");
  const notInvited = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.join(bob, requestId, room.roomId);
    })
  );
  expect(notInvited).toMatchObject({
    _tag: "NotInvited",
    message: `You are not invited to room ${room.roomId}. Ask a member to invite you.`,
    operation: "join",
    retryable: false,
  });
  const outsider = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.readMessages({
        actor: bob,
        limit: 10,
        requestId,
        roomId: room.roomId,
        since: 0,
        thread: null,
      });
    })
  );
  expect(outsider).toMatchObject({
    _tag: "NotMember",
    message: `You are not a member of room ${room.roomId}. Ask a member to invite you, then join.`,
    operation: "room.access",
    retryable: false,
  });
  const badLimit = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.readMessages({
        actor: ada,
        limit: 0,
        requestId,
        roomId: room.roomId,
        since: 0,
        thread: null,
      });
    })
  );
  expect(badLimit).toMatchObject({
    _tag: "InvalidArgument",
    message: "limit must be an integer from 1 to 200. Correct it and retry.",
    operation: "read_messages",
  });
  const badEmoji = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.react(admin, requestId, room.roomId, 2, "nope nope");
    })
  );
  expect(badEmoji).toMatchObject({
    _tag: "InvalidArgument",
    message:
      "emoji must be 1 to 16 characters without spaces. Correct it and retry.",
    operation: "react",
  });
  const added = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.react(admin, requestId, room.roomId, 2, "👀");
    })
  );
  expect(added.reactions).toEqual([{ agentId: admin.agentId, emoji: "👀" }]);
  const removed = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.react(admin, requestId, room.roomId, 2, "👀");
    })
  );
  expect(removed.reactions).toEqual([]);
  const invited = await invitePerson(run, admin, room.roomId, bob.agentId);
  expect(invited.joined).toBe(false);
  await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.join(bob, requestId, room.roomId);
    })
  );
  const stolen = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.redactMessage(bob, requestId, room.roomId, 2);
    })
  );
  expect(stolen).toMatchObject({
    _tag: "NotAuthor",
    message:
      "Message 2 belongs to someone else. You can redact only your own messages.",
    operation: "message.mutate",
  });
  const redacted = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.redactMessage(admin, requestId, room.roomId, 2);
    })
  );
  expect(redacted.redacted).toBe(true);
  expect(redacted.body).toBe("[redacted]");
  const missingAgent = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.rotateToken(admin, requestId, systemAgentId);
    })
  );
  expect(missingAgent).toMatchObject({
    _tag: "AgentNotFound",
    code: "AgentNotFound",
    message: `Agent ${systemAgentId} was not found. Check the id and retry.`,
    operation: "agent.read",
    retryable: false,
  });
  const privateHook = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.registerWebhook(
        ada,
        requestId,
        "https://10.1.1.1/hook"
      );
    })
  );
  expect(privateHook).toMatchObject({
    _tag: "InvalidArgument",
    message:
      "Webhook URL must not target a private or link-local address. Use https, or http://127.0.0.1 for a local listener.",
    operation: "register_webhook",
  });
  const found = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.searchMessages(
        admin,
        requestId,
        room.roomId,
        "missing-word",
        10
      );
    })
  );
  expect(found.messages).toEqual([]);
  const transcript = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.readTranscript({
        actor: admin,
        format: "markdown",
        limit: 10,
        requestId,
        roomId: room.roomId,
        since: 0,
        thread: null,
      });
    })
  );
  expect(transcript.format).toBe("markdown");
  expect(transcript.text.includes("status")).toBe(true);
  const everyone = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: ada,
        body: "wake @all",
        mentions: ["all"],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  expect(everyone.messages[0]?.mentions).toEqual(["all"]);
});

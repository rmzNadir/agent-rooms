import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  type DirectoryClient,
  directoryTarget,
} from "../src/app/chat-support.ts";
import { AgentId, RoomId } from "../src/domain/ids.ts";
import { hashToken } from "../src/domain/token.ts";
import { client } from "../src/model/client.ts";
import {
  Directory,
  RegisterAgent,
  ReserveRoom,
} from "../src/model/directory.ts";
import { CredentialBook } from "../src/runtime/credentials.ts";
import { fulfill } from "./effect-run.ts";
import {
  actorFor,
  chatEffect,
  chatRunner,
  createPerson,
  requestId,
  responseText,
} from "./live-chat.ts";
import { startHost } from "./object-host.ts";

const host = await startHost();
const { failure, run } = chatRunner(host);
const agent = Schema.decodeUnknownSync(AgentId);
const room = Schema.decodeUnknownSync(RoomId);
const earlyId = agent("agent_aaaaaaaaaaaaaaaaaaaaaaaa");
const missingId = agent("agent_ffffffffffffffffffffffff");
const reservedId = room("room_eeeeeeeeeeeeeeeeeeeeeeee");

test("directory and room branches stay observable", async () => {
  await run(
    Effect.gen(function* () {
      const directory = yield* client<DirectoryClient>(Directory);
      yield* directory.send(
        directoryTarget,
        new RegisterAgent({
          admin: false,
          agentId: earlyId,
          displayName: "early",
          kind: "agent",
          tokenHash: "early-hash",
        })
      );
    })
  );
  const adminHash = await Effect.runPromise(hashToken("admin-token"));
  const adminView = await run(
    chatEffect((chat) => chat.resolve(adminHash, adminHash, "human"))
  );
  expect(adminView).toMatchObject({ admin: true, displayName: "human" });
  const again = await run(
    chatEffect((chat) => chat.resolve(adminHash, adminHash, "human"))
  );
  expect(again.admin).toBe(true);
  expect(again.agentId).toBe(adminView.agentId);
  const adminBook = await fulfill(
    Effect.gen(function* () {
      return yield* (yield* CredentialBook).get(adminView.agentId);
    }).pipe(Effect.provide(host))
  );
  expect(adminBook?.admin).toBe(true);
  expect((adminBook?.secret.length ?? 0) > 0).toBe(true);
  const admin = actorFor(adminView.agentId, "human", true, "human");
  const { actor: ada } = await createPerson(run, admin, "ada", "agent");
  const { actor: amy } = await createPerson(run, admin, "amy", "agent");
  const self = await run(
    chatEffect((chat) => chat.rotateToken(ada, requestId, ada.agentId))
  );
  expect(self.token.length).toBeGreaterThan(0);
  const rotatedAdmin = await run(
    chatEffect((chat) => chat.rotateToken(admin, requestId, admin.agentId))
  );
  expect(rotatedAdmin.agent.admin).toBe(true);
  const missing = await failure(
    chatEffect((chat) => chat.rotateToken(admin, requestId, missingId))
  );
  expect(missing).toMatchObject({
    message: `Agent ${missingId} was not found. Check the id and retry.`,
  });
  const denied = await failure(
    chatEffect((chat) => chat.rotateToken(ada, requestId, amy.agentId))
  );
  expect(denied).toMatchObject({ operation: "rotate_token" });
  await run(
    Effect.gen(function* () {
      const directory = yield* client<DirectoryClient>(Directory);
      yield* directory.send(
        directoryTarget,
        new ReserveRoom({
          leadId: ada.agentId,
          memberIds: [ada.agentId],
          name: "zzz",
          roomId: reservedId,
          topic: "closed",
        })
      );
    })
  );
  const listed = await run(
    chatEffect((chat) => chat.listRooms(admin, requestId))
  );
  expect(listed.find((item) => item.roomId === reservedId)?.leadId).toBe(
    ada.agentId
  );
  const opened = await run(
    chatEffect((chat) =>
      chat.createRoom({
        actor: ada,
        memberIds: [ada.agentId, amy.agentId],
        name: "ops",
        requestId,
        topic: "ship",
      })
    )
  );
  const unread = await run(
    chatEffect((chat) => chat.getUnread(ada, requestId, opened.roomId))
  );
  expect(unread.latestSeq).toBe(0);
  expect(unread.lastReadSeq).toBe(0);
  const posted = await run(
    chatEffect((chat) =>
      chat.postMessage({
        actor: ada,
        body: "hello",
        mentions: ["amy"],
        replyTo: null,
        requestId,
        roomId: opened.roomId,
        threadRoot: null,
      })
    )
  );
  expect(posted.messages[0]?.seq).toBe(1);
  const edited = await run(
    chatEffect((chat) =>
      chat.editMessage(ada, requestId, opened.roomId, 1, "hello amy", ["amy"])
    )
  );
  expect(edited.mentions).toEqual(["amy"]);
  const page = await run(
    chatEffect((chat) =>
      chat.readMessages({
        actor: amy,
        limit: 10,
        requestId,
        roomId: opened.roomId,
        since: 0,
        thread: null,
      })
    )
  );
  expect(page.messages.length).toBe(1);
  const afterRead = await run(
    chatEffect((chat) => chat.getUnread(amy, requestId, opened.roomId))
  );
  expect(afterRead.lastReadSeq).toBe(1);
  expect(afterRead.latestSeq).toBe(1);
  await run(
    chatEffect((chat) =>
      chat.postMessage({
        actor: ada,
        body: "second",
        mentions: ["amy"],
        replyTo: null,
        requestId,
        roomId: opened.roomId,
        threadRoot: null,
      })
    )
  );
  const marked = await run(
    chatEffect((chat) => chat.markRead(amy, requestId, opened.roomId, 2))
  );
  expect(marked.lastReadSeq).toBe(2);
  expect(marked.latestSeq).toBe(2);
  const rewound = await run(
    chatEffect((chat) => chat.markRead(amy, requestId, opened.roomId, 1))
  );
  expect(rewound.lastReadSeq).toBe(2);
  expect(rewound.latestSeq).toBe(2);
  const { actor: sam } = await createPerson(run, admin, "sam", "agent");
  const invited = await run(
    chatEffect((chat) =>
      chat.invite(ada, requestId, opened.roomId, sam.agentId)
    )
  );
  expect(invited.agentId).toBe(sam.agentId);
  const joined = await run(
    chatEffect((chat) => chat.join(sam, requestId, opened.roomId))
  );
  expect(joined.agentId).toBe(sam.agentId);
  const unknown = await failure(
    chatEffect((chat) => chat.invite(ada, requestId, opened.roomId, missingId))
  );
  expect(unknown).toMatchObject({
    message: `Agent ${missingId} was not found. Check the id and retry.`,
  });
  const socket = await run(
    chatEffect((chat) =>
      chat.forward(
        opened.roomId,
        HttpServerRequest.fromWeb(
          new Request("https://room.internal/socket", {
            headers: { upgrade: "nope" },
          })
        ),
        requestId
      )
    )
  );
  expect(await responseText(socket)).toEqual({
    body: "Open the room socket with a websocket upgrade.",
    status: 400,
  });
  const redacted = await failure(
    chatEffect((chat) => chat.redactMessage(amy, requestId, opened.roomId, 1))
  );
  expect(redacted).toMatchObject({
    message:
      "Message 1 belongs to someone else. You can redact only your own messages.",
  });
  expect(
    await failure(
      chatEffect((chat) => chat.listThreads(ada, requestId, opened.roomId, 0))
    )
  ).toMatchObject({ operation: "list_threads" });
  expect(
    await failure(
      chatEffect((chat) =>
        chat.postMessage({
          actor: ada,
          body: "",
          mentions: [],
          replyTo: null,
          requestId,
          roomId: opened.roomId,
          threadRoot: null,
        })
      )
    )
  ).toMatchObject({ operation: "post_message" });
  expect(
    await failure(
      chatEffect((chat) =>
        chat.readMessages({
          actor: ada,
          limit: 10,
          requestId,
          roomId: opened.roomId,
          since: -1,
          thread: null,
        })
      )
    )
  ).toMatchObject({ operation: "read_messages" });
  expect(
    await failure(
      chatEffect((chat) =>
        chat.readTranscript({
          actor: ada,
          format: "markdown",
          limit: 0,
          requestId,
          roomId: opened.roomId,
          since: 0,
          thread: null,
        })
      )
    )
  ).toMatchObject({ operation: "read_transcript" });
  expect(
    await failure(
      chatEffect((chat) =>
        chat.searchMessages(ada, requestId, opened.roomId, "hello", 0)
      )
    )
  ).toMatchObject({ operation: "search_messages" });
  expect(
    await failure(
      chatEffect((chat) =>
        chat.waitForMessages(ada, requestId, opened.roomId, 0, 0, 0)
      )
    )
  ).toMatchObject({ operation: "wait_for_messages" });
  expect(
    await failure(
      chatEffect((chat) =>
        chat.waitForMessages(ada, requestId, opened.roomId, -1, 10, 0)
      )
    )
  ).toMatchObject({ operation: "wait_for_messages" });
});

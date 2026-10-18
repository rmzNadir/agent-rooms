import { expect, test } from "bun:test";
import { Effect, Layer, Schema, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { writeEnv } from "../src/boundary/external.ts";
import { AgentId } from "../src/domain/ids.ts";
import { hashToken } from "../src/domain/token.ts";
import {
  CredentialBook,
  legacySkip,
  memoryCredentials,
} from "../src/runtime/credentials.ts";
import { roomsInMemory } from "../src/runtime/domain-host.ts";
import { RoomSockets } from "../src/runtime/sockets.ts";
import { fulfill } from "./effect-run.ts";
import {
  actorFor,
  chatEffect,
  chatRunner,
  createPerson,
  requestId,
  responseText,
} from "./live-chat.ts";

const published: string[] = [];

const socketLayer = Layer.succeed(
  RoomSockets,
  RoomSockets.of({
    close: () => Effect.void,
    open: () =>
      Effect.succeed(HttpServerResponse.text("upgraded", { status: 200 })),
    publish: (_roomId, text) =>
      Effect.sync(() => {
        published.push(text);
      }),
  })
);

const scope = await Effect.runPromise(Scope.make());
writeEnv("ALCHEMY_PHASE", "runtime");
const context = await fulfill(
  Layer.build(
    Layer.mergeAll(
      legacySkip,
      memoryCredentials(),
      socketLayer,
      roomsInMemory().pipe(Layer.provide(memoryCredentials()))
    )
  ).pipe(Effect.provideService(Scope.Scope, scope))
);
const host = Layer.succeedContext(context);
const { failure, run } = chatRunner(host);

test("chat keeps exact auth, room, and socket results", async () => {
  const adminHash = await Effect.runPromise(hashToken("admin-token"));
  const badAdmin = await failure(
    chatEffect((chat) => chat.resolve(adminHash, adminHash, "bad name"))
  );
  expect(badAdmin).toMatchObject({
    _tag: "InvalidArgument",
    details: {
      constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}",
      field: "adminName",
    },
    message:
      "AGENT_ROOMS_ADMIN_NAME must be a single mention token such as human.",
    operation: "authenticate",
    retryable: false,
  });
  const adminView = await run(
    chatEffect((chat) => chat.resolve(adminHash, adminHash, "human"))
  );
  expect(adminView.admin).toBe(true);
  expect(adminView.displayName).toBe("human");
  expect(adminView.kind).toBe("human");
  const stranger = await Effect.runPromise(hashToken("stranger"));
  const unrecognized = await failure(
    chatEffect((chat) => chat.resolve(stranger, adminHash, "human"))
  );
  expect(unrecognized).toMatchObject({
    message: "The bearer token was not recognized. Check the token and retry.",
    operation: "authenticate",
  });
  const admin = actorFor(adminView.agentId, "human", true, "human");
  const who = await run(
    chatEffect((chat) => Effect.succeed(chat.whoami(admin)))
  );
  expect(who).toMatchObject({
    admin: true,
    displayName: "human",
    kind: "human",
  });
  const { actor: ada, created } = await createPerson(
    run,
    admin,
    "zed",
    "agent"
  );
  expect(created.agent.admin).toBe(false);
  const stored = await fulfill(
    Effect.gen(function* () {
      return yield* (yield* CredentialBook).get(ada.agentId);
    }).pipe(Effect.provide(host))
  );
  expect(stored).toEqual({
    admin: false,
    secret: created.webhookSecret,
    url: null,
  });
  const { actor: amy } = await createPerson(run, admin, "amy", "agent");
  const names = await run(
    chatEffect((chat) => chat.listAgents(admin, requestId))
  );
  expect(names.map((agent) => agent.displayName)).toEqual([
    "amy",
    "human",
    "zed",
  ]);
  expect(names.find((agent) => agent.displayName === "amy")?.admin).toBe(false);
  expect(names.find((agent) => agent.displayName === "human")?.admin).toBe(
    true
  );
  const outsider = await failure(
    chatEffect((chat) =>
      chat.createAgent(ada, requestId, "nope", "agent", null)
    )
  );
  expect(outsider).toMatchObject({
    message:
      "That action is limited to the admin human. Use an admin token and retry.",
    operation: "create_agent",
  });
  const duplicate = await failure(
    chatEffect((chat) =>
      chat.createAgent(admin, requestId, "amy", "agent", null)
    )
  );
  expect(duplicate).toMatchObject({
    message:
      "An agent named amy already exists. Choose a different display name.",
  });
  const privateUrl = await failure(
    chatEffect((chat) =>
      chat.createAgent(
        admin,
        requestId,
        "neo",
        "agent",
        "https://10.1.2.3/hook"
      )
    )
  );
  expect(privateUrl).toMatchObject({
    details: {
      constraint: "must not target a private or link-local address",
      field: "webhookUrl",
    },
    operation: "create_agent",
  });
  const missing = await failure(
    chatEffect((chat) =>
      chat.createRoom({
        actor: admin,
        memberIds: [
          Schema.decodeUnknownSync(AgentId)("agent_aaaaaaaaaaaaaaaaaaaaaaaa"),
        ],
        name: "ops",
        requestId,
        topic: "ship",
      })
    )
  );
  expect(missing).toMatchObject({
    message:
      "Agent agent_aaaaaaaaaaaaaaaaaaaaaaaa was not found. Check the id and retry.",
    operation: "agent.read",
  });
  const room = await run(
    chatEffect((chat) =>
      chat.createRoom({
        actor: admin,
        memberIds: [ada.agentId, amy.agentId],
        name: "ops",
        requestId,
        topic: "ship",
      })
    )
  );
  expect(room.youAreLead).toBe(false);
  expect(room.leadId).toBe(ada.agentId);
  const earlier = await run(
    chatEffect((chat) =>
      chat.createRoom({
        actor: amy,
        memberIds: [amy.agentId],
        name: "aaa",
        requestId,
        topic: "first",
      })
    )
  );
  expect(earlier.youAreLead).toBe(true);
  const listed = await run(
    chatEffect((chat) => chat.listRooms(admin, requestId))
  );
  expect(listed.map((item) => item.name)).toEqual(["aaa", "ops"]);
  const adaRooms = await run(
    chatEffect((chat) => chat.listRooms(ada, requestId))
  );
  expect(adaRooms.map((item) => item.name)).toEqual(["ops"]);
  expect(adaRooms[0]?.youAreLead).toBe(true);
  const amyRooms = await run(
    chatEffect((chat) => chat.listRooms(amy, requestId))
  );
  expect(amyRooms.map((item) => item.name)).toEqual(["aaa", "ops"]);
  const members = await run(
    chatEffect((chat) => chat.members(admin, requestId, room.roomId))
  );
  expect(
    members.members.find((member) => member.agentId === ada.agentId)?.role
  ).toBe("lead");
  expect(
    members.members.find((member) => member.agentId === amy.agentId)?.role
  ).toBe("member");
  const hiddenFail = await failure(
    chatEffect((chat) => chat.listAgents(ada, requestId))
  );
  expect(hiddenFail).toMatchObject({ operation: "list_agents" });
  const posted = await run(
    chatEffect((chat) =>
      chat.postMessage({
        actor: ada,
        body: "hello",
        mentions: ["amy"],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      })
    )
  );
  expect(posted.messages[0]?.mentions).toEqual(["amy"]);
  expect(published.at(-1)).toContain('"type":"message"');
  expect(published.at(-1)).toContain("hello");
  const plain = await run(
    chatEffect((chat) =>
      chat.forward(
        room.roomId,
        HttpServerRequest.fromWeb(new Request("https://room.internal/socket")),
        requestId
      )
    )
  );
  expect(await responseText(plain)).toEqual({
    body: "Open the room socket with a websocket upgrade.",
    status: 400,
  });
  const unsigned = await run(
    chatEffect((chat) =>
      chat.forward(
        room.roomId,
        HttpServerRequest.fromWeb(
          new Request("https://room.internal/socket", {
            headers: { upgrade: "WebSocket" },
          })
        ),
        requestId
      )
    )
  );
  expect(await responseText(unsigned)).toEqual({
    body: "Sign in before opening the room socket.",
    status: 401,
  });
  const { actor: sam } = await createPerson(run, admin, "sam", "agent");
  const guest = await run(
    chatEffect((chat) =>
      chat.forward(
        room.roomId,
        HttpServerRequest.fromWeb(
          new Request("https://room.internal/socket", {
            headers: {
              upgrade: "websocket",
              "x-agent-rooms-agent": sam.agentId,
            },
          })
        ),
        requestId
      )
    )
  );
  expect(await responseText(guest)).toEqual({
    body: "Join the room before opening the socket.",
    status: 403,
  });
  const opened = await run(
    chatEffect((chat) =>
      chat.forward(
        room.roomId,
        HttpServerRequest.fromWeb(
          new Request("https://room.internal/socket", {
            headers: {
              upgrade: "WebSocket",
              "x-agent-rooms-agent": ada.agentId,
            },
          })
        ),
        requestId
      )
    )
  );
  expect(await responseText(opened)).toEqual({ body: "upgraded", status: 200 });
  const rotated = await run(
    chatEffect((chat) => chat.rotateToken(admin, requestId, ada.agentId))
  );
  expect(rotated.webhookSecret).toBe(created.webhookSecret);
  expect(rotated.agent.admin).toBe(false);
  const deniedRotate = await failure(
    chatEffect((chat) => chat.rotateToken(amy, requestId, ada.agentId))
  );
  expect(deniedRotate).toMatchObject({ operation: "rotate_token" });
  const hooked = await run(
    chatEffect((chat) =>
      chat.registerWebhook(ada, requestId, "https://listener.example/hook")
    )
  );
  expect(hooked.roomIds).toEqual([room.roomId]);
  const again = await run(
    chatEffect((chat) =>
      chat.registerWebhook(ada, requestId, "https://listener.example/hook")
    )
  );
  const kept = await fulfill(
    Effect.gen(function* () {
      return yield* (yield* CredentialBook).get(ada.agentId);
    }).pipe(Effect.provide(host))
  );
  expect(again.webhookUrl).toBe("https://listener.example/hook");
  expect(kept?.secret).toBe(created.webhookSecret);
  expect(kept?.url).toBe("https://listener.example/hook");
  const notAuthor = await failure(
    chatEffect((chat) =>
      chat.editMessage(admin, requestId, room.roomId, 1, "nope", [])
    )
  );
  expect(notAuthor).toMatchObject({
    message:
      "Message 1 belongs to someone else. You can edit only your own messages.",
    operation: "message.mutate",
  });
  const absent = await failure(
    chatEffect((chat) =>
      chat.editMessage(ada, requestId, room.roomId, 99, "nope", [])
    )
  );
  expect(absent).toMatchObject({
    message: `Message 99 was not found in room ${room.roomId}.`,
    operation: "message.read",
  });
  const emptyBody = await failure(
    chatEffect((chat) =>
      chat.postMessage({
        actor: ada,
        body: "   ",
        mentions: [],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      })
    )
  );
  expect(emptyBody).toMatchObject({
    message: "body must be 1 to 8000 characters. Correct it and retry.",
  });
  const solo = await failure(
    chatEffect((chat) => chat.leave(amy, requestId, earlier.roomId))
  );
  expect(solo).toMatchObject({
    message: `You are the only member of room ${earlier.roomId}. Invite someone else before leaving.`,
    operation: "leave",
  });
});

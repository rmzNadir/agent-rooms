import { expect, test } from "bun:test";
import type { WebSocket } from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import {
  createAgent,
  getAgent,
  listAgents,
  resolve,
  rotateToken,
  setWebhook,
} from "../src/directory/directory-agents.ts";
import {
  CreateAgentPayload,
  DeleteRoomPayload,
  GetAgentPayload,
  ListAgentsPayload,
  ListRoomsPayload,
  PutRoomPayload,
  ResolvePayload,
  RotateTokenPayload,
  SetWebhookPayload,
} from "../src/directory/directory-http-api.ts";
import {
  deleteRoom,
  listRooms,
  putRoom,
} from "../src/directory/directory-rooms.ts";
import { migrateDirectory } from "../src/directory/directory-sql.ts";
import { Actor } from "../src/domain/actor.ts";
import { type AgentId, internalRequestId, RoomId } from "../src/domain/ids.ts";
import { hashToken } from "../src/domain/token.ts";
import {
  EditPayload,
  InitMember,
  InitRoomPayload,
  LeavePayload,
  MembersPayload,
  PostPayload,
  ReadPayload,
  SearchPayload,
} from "../src/room/room-http-api.ts";
import { initRoom, leave, listMembers } from "../src/room/room-membership.ts";
import { edit } from "../src/room/room-mutate.ts";
import { postMessage } from "../src/room/room-post.ts";
import { readMessages, search } from "../src/room/room-read.ts";
import { migrateRoom } from "../src/room/room-sql.ts";
import { openState } from "./sqlite-state.ts";

const requestId = internalRequestId;
const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);

const actorFor = (
  agentId: AgentId,
  displayName: string,
  admin: boolean,
  kind: "agent" | "human"
) => new Actor({ admin, agentId, displayName, kind });

test("directory bootstrap, agent lifecycle, and room membership persist in sqlite", async () => {
  const directory = openState("directory");
  const adminHash = await directory(hashToken("admin-token"));
  await directory(migrateDirectory);
  const admin = await directory(
    resolve(
      new ResolvePayload({
        adminName: "human",
        adminTokenHash: adminHash,
        requestId,
        tokenHash: adminHash,
      })
    )
  );
  expect(admin.admin).toBe(true);
  expect(admin.displayName).toBe("human");
  expect(admin.kind).toBe("human");

  const again = await directory(
    resolve(
      new ResolvePayload({
        adminName: "human",
        adminTokenHash: adminHash,
        requestId,
        tokenHash: adminHash,
      })
    )
  );
  expect(again.agentId).toBe(admin.agentId);

  const created = await directory(
    createAgent(
      new CreateAgentPayload({
        actor: actorFor(admin.agentId, "human", true, "human"),
        displayName: "ada",
        kind: "agent",
        requestId,
        webhookUrl: null,
      })
    )
  );
  expect(created.agent.displayName).toBe("ada");
  expect(created.agent.admin).toBe(false);
  expect(created.token.length).toBeGreaterThan(0);

  const listed = await directory(
    listAgents(
      new ListAgentsPayload({
        actor: actorFor(admin.agentId, "human", true, "human"),
        requestId,
      })
    )
  );
  expect(listed.agents.map((agent) => agent.displayName)).toEqual([
    "ada",
    "human",
  ]);

  const denied = await directory(
    createAgent(
      new CreateAgentPayload({
        actor: actorFor(created.agent.agentId, "ada", false, "agent"),
        displayName: "bob",
        kind: "agent",
        requestId,
        webhookUrl: null,
      })
    ).pipe(Effect.flip)
  );
  expect(denied._tag).toBe("Forbidden");

  const adaToken = await directory(hashToken(created.token));
  const ada = await directory(
    resolve(
      new ResolvePayload({
        adminName: "human",
        adminTokenHash: adminHash,
        requestId,
        tokenHash: adaToken,
      })
    )
  );
  expect(ada.agentId).toBe(created.agent.agentId);

  const rotated = await directory(
    rotateToken(
      new RotateTokenPayload({
        actor: actorFor(admin.agentId, "human", true, "human"),
        agentId: created.agent.agentId,
        requestId,
      })
    )
  );
  expect(rotated.token).not.toBe(created.token);
  const stale = await directory(
    resolve(
      new ResolvePayload({
        adminName: "human",
        adminTokenHash: adminHash,
        requestId,
        tokenHash: adaToken,
      })
    ).pipe(Effect.flip)
  );
  expect(stale._tag).toBe("Unauthorized");

  const hooked = await directory(
    setWebhook(
      new SetWebhookPayload({
        actor: actorFor(created.agent.agentId, "ada", false, "agent"),
        requestId,
        webhookUrl: "https://listener.example/hook",
      })
    )
  );
  expect(hooked.webhookUrl).toBe("https://listener.example/hook");
  const loaded = await directory(
    getAgent(new GetAgentPayload({ agentId: created.agent.agentId, requestId }))
  );
  expect(loaded.webhookUrl).toBe("https://listener.example/hook");

  const human = actorFor(admin.agentId, "human", true, "human");
  const saved = await directory(
    putRoom(
      new PutRoomPayload({
        actor: human,
        leadId: admin.agentId,
        memberIds: [admin.agentId, created.agent.agentId],
        name: "ops",
        requestId,
        roomId,
        topic: "delivery",
      })
    )
  );
  expect(saved.name).toBe("ops");
  expect(saved.youAreLead).toBe(true);
  const clash = await directory(
    putRoom(
      new PutRoomPayload({
        actor: human,
        leadId: admin.agentId,
        name: "ops",
        requestId,
        roomId: Schema.decodeUnknownSync(RoomId)(
          "room_bbbbbbbbbbbbbbbbbbbbbbbb"
        ),
        topic: "other",
      })
    ).pipe(Effect.flip)
  );
  expect(clash._tag).toBe("RoomNameTaken");
  const rooms = await directory(
    listRooms(new ListRoomsPayload({ actor: human, requestId }))
  );
  expect(rooms.rooms.map((item) => item.name)).toEqual(["ops"]);
  await directory(deleteRoom(new DeleteRoomPayload({ requestId, roomId })));
  const afterDelete = await directory(
    listRooms(new ListRoomsPayload({ actor: human, requestId }))
  );
  expect(afterDelete.rooms).toEqual([]);

  const room = openState(roomId);
  await room(migrateRoom);
  const summary = await room(
    initRoom(
      new InitRoomPayload({
        leadId: admin.agentId,
        members: [
          new InitMember({
            agentId: admin.agentId,
            displayName: "human",
            kind: "human",
            role: "lead",
            webhookSecret: null,
            webhookUrl: null,
          }),
          new InitMember({
            agentId: created.agent.agentId,
            displayName: "ada",
            kind: "agent",
            role: "member",
            webhookSecret: hooked.webhookSecret,
            webhookUrl: "https://listener.example/hook",
          }),
        ],
        name: "ops",
        requestId,
        roomId,
        topic: "delivery",
      })
    )
  );
  expect(summary.name).toBe("ops");
  expect(summary.youAreLead).toBe(true);
  const members = await room(
    listMembers(
      new MembersPayload({
        actor: actorFor(admin.agentId, "human", true, "human"),
        requestId,
      })
    )
  );
  expect(members.members.map((member) => member.displayName)).toEqual([
    "ada",
    "human",
  ]);
  expect(members.members.every((member) => member.joined)).toBe(true);

  const post = postMessage(
    () => Effect.void,
    () => Effect.void
  );
  const blank = await room(
    post(
      new PostPayload({
        actor: human,
        body: "   ",
        mentions: [],
        replyTo: null,
        requestId,
        threadRoot: null,
      })
    ).pipe(Effect.flip)
  );
  expect(blank._tag).toBe("InvalidArgument");
  const page = await room(
    post(
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
  const [first] = page.messages;
  expect(first?.body).toBe("hello @ada");
  const read = await room(
    readMessages(
      new ReadPayload({
        actor: actorFor(created.agent.agentId, "ada", false, "agent"),
        limit: 10,
        requestId,
        since: 0,
        thread: null,
      })
    )
  );
  expect(read.messages.some((message) => message.body === "hello @ada")).toBe(
    true
  );
  if (first === undefined) {
    throw new Error("The room did not store the posted message.");
  }
  const changed = edit(() => Effect.void);
  const updated = await room(
    changed(
      new EditPayload({
        actor: human,
        body: "hello @ada again",
        mentions: ["ada"],
        requestId,
        seq: first.seq,
      })
    )
  );
  expect(updated.body).toBe("hello @ada again");
  const found = await room(
    search(
      new SearchPayload({
        actor: human,
        limit: 10,
        query: "again",
        requestId,
      })
    )
  );
  expect(found.messages.map((message) => message.seq)).toEqual([first.seq]);
  const emptyQuery = await room(
    search(
      new SearchPayload({
        actor: human,
        limit: 10,
        query: " ",
        requestId,
      })
    ).pipe(Effect.flip)
  );
  expect(emptyQuery._tag).toBe("InvalidArgument");
  const sockets = new Map<string, WebSocket>();
  await room(
    leave(sockets)(
      new LeavePayload({
        actor: actorFor(created.agent.agentId, "ada", false, "agent"),
        requestId,
      })
    )
  );
  const afterAda = await room(
    listMembers(new MembersPayload({ actor: human, requestId }))
  );
  expect(afterAda.members.map((member) => member.displayName)).toEqual([
    "human",
  ]);
  const solo = await room(
    leave(sockets)(new LeavePayload({ actor: human, requestId })).pipe(
      Effect.flip
    )
  );
  expect(solo._tag).toBe("Forbidden");
});

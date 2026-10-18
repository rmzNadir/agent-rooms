import { expect, test } from "bun:test";
import { Context, Effect, Layer, Schema, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Chat, chatLayer } from "../src/app/chat.ts";
import { Actor } from "../src/domain/actor.ts";
import { internalRequestId, RoomId } from "../src/domain/ids.ts";
import { execRows } from "../src/domain/sql-exec.ts";
import { hashToken } from "../src/domain/token.ts";
import { client } from "../src/model/client.ts";
import { Directory } from "../src/model/directory.ts";
import { Room } from "../src/model/room.ts";
import {
  CredentialBook,
  legacySkip,
  memoryCredentials,
} from "../src/runtime/credentials.ts";
import { roomsInMemory } from "../src/runtime/domain-host.ts";
import {
  applyDirectory,
  applyRoom,
  type DirectoryHandle,
  type RoomHandle,
} from "../src/runtime/legacy-apply.ts";
import {
  type DoorNamespace,
  doorCredentials,
  doorLegacy,
} from "../src/runtime/legacy-client.ts";
import {
  directoryDoorFetch,
  roomDoorFetch,
} from "../src/runtime/legacy-door.ts";
import {
  readDirectoryTables,
  readRoomTables,
} from "../src/runtime/legacy-store.ts";
import { socketsSkip } from "../src/runtime/sockets.ts";
import {
  buildIn,
  buildProvided,
  fulfill,
  provideLayer,
  runIn,
} from "./effect-run.ts";
import { asService, memoryLayer } from "./sqlite-state.ts";

const agentId = "agent_bbbbbbbbbbbbbbbbbbbbbbbb";
const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";
const token = "legacy-token";

const statement = (sql: string, ...bindings: Array<string | number | null>) =>
  execRows(sql, bindings, "seed");

const seedDirectory = (tokenHash: string) =>
  Effect.gen(function* () {
    yield* statement(
      `CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        admin INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        webhook_url TEXT,
        webhook_secret TEXT NOT NULL
      )`
    );
    yield* statement(
      `CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        lead_id TEXT NOT NULL
      )`
    );
    yield* statement(
      `CREATE TABLE memberships (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      )`
    );
    yield* statement(
      "INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret) VALUES (?, 'human', 'human', 1, ?, 'http://127.0.0.1/hook', 'whsec-keep')",
      agentId,
      tokenHash
    );
    yield* statement(
      "INSERT INTO rooms (id, name, topic, lead_id) VALUES (?, 'ops', 'delivery', ?)",
      roomId,
      agentId
    );
    yield* statement(
      "INSERT INTO memberships (room_id, agent_id) VALUES (?, ?)",
      roomId,
      agentId
    );
  });

const seedRoom = Effect.gen(function* () {
  yield* statement(
    `CREATE TABLE room_flags (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      topic TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      hop_count INTEGER NOT NULL,
      paused INTEGER NOT NULL
    )`
  );
  yield* statement(
    `CREATE TABLE members (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL,
      joined INTEGER NOT NULL,
      last_read_seq INTEGER NOT NULL,
      wake_seq INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT,
      webhook_secret TEXT
    )`
  );
  yield* statement(
    `CREATE TABLE messages (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions_json TEXT NOT NULL,
      thread_root INTEGER,
      reply_to INTEGER,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      redacted INTEGER NOT NULL
    )`
  );
  yield* statement(
    "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, 'ops', 'delivery', ?, 4, 0)",
    agentId
  );
  yield* statement(
    "INSERT INTO members (agent_id, display_name, kind, role, joined, last_read_seq, webhook_url, webhook_secret) VALUES (?, 'human', 'human', 'lead', 1, 0, 'http://127.0.0.1/hook', 'whsec-keep')",
    agentId
  );
  yield* statement(
    "INSERT INTO messages (seq, id, author_id, author_name, author_kind, body, mentions_json, thread_root, reply_to, created_at, edited_at, redacted) VALUES (1, 'msg_old', ?, 'human', 'human', 'kept', '[]', NULL, NULL, 10, NULL, 0)",
    agentId
  );
});

const baseLayer = Layer.mergeAll(
  memoryCredentials(),
  legacySkip,
  socketsSkip,
  roomsInMemory().pipe(Layer.provide(memoryCredentials()))
);

test("a legacy sqlite fixture imports once and keeps the token and webhook secret", async () => {
  const tokenHash = await Effect.runPromise(hashToken(token));
  const scope = await Effect.runPromise(Scope.make());
  const baseContext = await buildIn(baseLayer, scope);
  const chatContext = await buildProvided(chatLayer, baseContext, scope);
  const context = Context.merge(baseContext, chatContext);
  const domain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runIn(effect, context, scope);
  const directorySql = memoryLayer("legacy-directory");
  const roomSql = memoryLayer("legacy-room");
  expect(await provideLayer(readDirectoryTables, directorySql)).toBeUndefined();
  await provideLayer(seedDirectory(tokenHash), directorySql);
  await provideLayer(seedRoom, roomSql);
  const directorySnapshot = await provideLayer(
    readDirectoryTables,
    directorySql
  );
  const roomSnapshot = await provideLayer(readRoomTables(roomId), roomSql);
  if (directorySnapshot === undefined || roomSnapshot === undefined) {
    throw new Error("legacy tables did not decode");
  }

  const imported = await domain(
    Effect.gen(function* () {
      const directory = yield* client<DirectoryHandle>(Directory);
      const rooms = yield* client<RoomHandle>(Room);
      const book = yield* CredentialBook;
      yield* applyDirectory(directorySnapshot, book, directory);
      yield* applyRoom(roomSnapshot, book, rooms);
      yield* applyDirectory(directorySnapshot, book, directory);
      yield* applyRoom(roomSnapshot, book, rooms);
      const agents = (yield* directory.state("directory")) as {
        readonly agents: readonly {
          readonly admin?: boolean;
          readonly tokenHash: string;
        }[];
      };
      const room = asService<{
        readonly hopCount: number;
        readonly messages: readonly { readonly body: string }[];
      }>(yield* rooms.state(roomId));
      const secret = yield* book.get(agentId);
      const chat = yield* Chat;
      const identity = yield* chat.resolve(tokenHash, tokenHash, "human");
      return { agents, identity, room, secret };
    })
  );

  expect(imported.agents.agents).toHaveLength(1);
  expect(imported.agents.agents[0]?.tokenHash).toBe(tokenHash);
  expect(imported.agents.agents[0]?.admin).toBe(true);
  expect(imported.room.messages).toHaveLength(1);
  expect(imported.room.messages[0]?.body).toBe("kept");
  expect(imported.room.hopCount).toBe(4);
  expect(imported.secret).toEqual({
    admin: true,
    secret: "whsec-keep",
    url: "http://127.0.0.1/hook",
  });
  expect(`${imported.identity.agentId}`).toBe(agentId);
  expect(imported.identity.admin).toBe(true);
  expect(imported.identity.displayName).toBe("human");
});

test("the door replays a legacy sqlite fixture once and keeps the token and webhook secret", async () => {
  const tokenHash = await Effect.runPromise(hashToken(token));
  const scope = await Effect.runPromise(Scope.make());
  const directorySql = memoryLayer("door-directory");
  const roomSql = memoryLayer("door-room");
  const sessions: Parameters<typeof roomDoorFetch>[0] = new Map();
  const directoryNs = {
    getByName: () => ({
      fetch: (request: HttpServerRequest.HttpServerRequest) =>
        directoryDoorFetch.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provide(directorySql)
        ) as Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>,
    }),
  } as DoorNamespace;
  const roomNs = {
    getByName: () => ({
      fetch: (request: HttpServerRequest.HttpServerRequest) =>
        roomDoorFetch(sessions).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provide(roomSql)
        ) as Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>,
    }),
  } as DoorNamespace;
  await provideLayer(seedDirectory(tokenHash), directorySql);
  await provideLayer(seedRoom, roomSql);
  const credentials = doorCredentials(directoryNs);
  const hosted = roomsInMemory().pipe(Layer.provide(memoryCredentials()));
  const baseContext = await buildIn(
    Layer.mergeAll(hosted, credentials, socketsSkip),
    scope
  );
  const legacyContext = await buildProvided(
    doorLegacy(directoryNs, roomNs),
    baseContext,
    scope
  );
  const chatContext = await buildProvided(
    chatLayer,
    Context.merge(baseContext, legacyContext),
    scope
  );
  const context = Context.merge(
    baseContext,
    Context.merge(legacyContext, chatContext)
  );
  const brandedRoom = Schema.decodeUnknownSync(RoomId)(roomId);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runIn(effect, context, scope);
  const imported = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      const book = yield* CredentialBook;
      const rooms = yield* client<RoomHandle>(Room);
      const identity = yield* chat.resolve(tokenHash, tokenHash, "human");
      const actor = new Actor({
        admin: identity.admin,
        agentId: identity.agentId,
        displayName: identity.displayName,
        kind: identity.kind,
      });
      const input = {
        actor,
        limit: 50,
        requestId: internalRequestId,
        roomId: brandedRoom,
        since: 0,
        thread: null as number | null,
      };
      const page = yield* chat.readMessages(input);
      yield* chat.resolve(tokenHash, tokenHash, "human");
      const again = yield* chat.readMessages(input);
      const room = asService<{
        readonly hopCount: number;
        readonly messages: readonly { readonly body: string }[];
      }>(yield* rooms.state(brandedRoom));
      const secret = yield* book.get(agentId);
      return { again, identity, page, room, secret };
    })
  );
  const directoryProbe = await fulfill(
    directoryNs
      .getByName("directory")
      .fetch(HttpServerRequest.fromWeb(new Request("https://door.internal/")))
  );
  const roomProbe = await fulfill(
    roomNs
      .getByName(roomId)
      .fetch(
        HttpServerRequest.fromWeb(
          new Request(`https://door.internal/?roomId=${roomId}`)
        )
      )
  );
  expect(imported.page.messages).toHaveLength(1);
  expect(imported.page.messages[0]?.body).toBe("kept");
  expect(imported.again.messages).toHaveLength(1);
  expect(imported.again.messages[0]?.body).toBe("kept");
  expect(imported.room.hopCount).toBe(4);
  expect(imported.room.messages).toHaveLength(1);
  expect(imported.secret).toEqual({
    admin: true,
    secret: "whsec-keep",
    url: "http://127.0.0.1/hook",
  });
  expect(`${imported.identity.agentId}`).toBe(agentId);
  expect(await HttpServerResponse.toWeb(directoryProbe).json()).toEqual({
    migrated: true,
    snapshot: null,
  });
  expect(await HttpServerResponse.toWeb(roomProbe).json()).toEqual({
    migrated: true,
    snapshot: null,
  });
});

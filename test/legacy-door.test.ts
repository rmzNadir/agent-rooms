import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { execRows } from "../src/domain/sql-exec.ts";
import {
  buildDirectoryDoor,
  buildRoomDoor,
  directoryClassName,
  directoryDoorFetch,
  roomClassName,
  roomDoorFetch,
} from "../src/runtime/legacy-door.ts";
import { fulfill, provideLayer } from "./effect-run.ts";
import { memoryLayer } from "./sqlite-state.ts";

const agentId = "agent_bbbbbbbbbbbbbbbbbbbbbbbb";
const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";

const withDoor = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: Request,
  layer: ReturnType<typeof memoryLayer>
) =>
  fulfill(
    effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request)
      ),
      Effect.provide(layer)
    ) as Effect.Effect<A, never, never>
  );

const bodyOf = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.toWeb(response).json();

const textOf = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.toWeb(response).text();

const AgentSnapshot = Schema.Struct({
  migrated: Schema.Boolean,
  snapshot: Schema.NullOr(
    Schema.Struct({
      agents: Schema.Array(
        Schema.Struct({
          displayName: Schema.String,
          tokenHash: Schema.String,
        })
      ),
    })
  ),
});

const RoomSnapshot = Schema.Struct({
  migrated: Schema.Boolean,
  snapshot: Schema.NullOr(
    Schema.Struct({
      hopCount: Schema.Number,
      name: Schema.String,
    })
  ),
});

class DoorSocket {
  readonly sent: string[] = [];
  readonly closed: Array<{ readonly code: number; readonly reason: string }> =
    [];
  send(data: string) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed.push({ code, reason });
  }
}

const serverSockets: DoorSocket[] = [];

const DoorPair = function DoorPair() {
  const server = new DoorSocket();
  serverSockets.push(server);
  return [new DoorSocket(), server];
};

const installPair = () => {
  const previous = Reflect.get(globalThis, "WebSocketPair");
  Reflect.set(globalThis, "WebSocketPair", DoorPair);
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "WebSocketPair");
    } else {
      Reflect.set(globalThis, "WebSocketPair", previous);
    }
  };
};

test("directory and room class names stay on the legacy durable object classes", () => {
  expect(directoryClassName).toBe("DirectoryServer");
  expect(roomClassName).toBe("RoomServer");
});

test("directory and room doors build a fetch handler", async () => {
  const directory = await fulfill(Effect.flatten(buildDirectoryDoor));
  const first = await fulfill(Effect.flatten(buildRoomDoor));
  const second = await fulfill(Effect.flatten(buildRoomDoor));
  expect(directory.fetch).toBe(directoryDoorFetch);
  expect(Effect.isEffect(first.fetch)).toBe(true);
  expect(first.fetch).not.toBe(second.fetch);
});

test("the directory door stores credentials and marks a snapshot imported", async () => {
  const layer = memoryLayer("directory-door");
  const missing = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential"),
    layer
  );
  const absent = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential?agentId=agent_x"),
    layer
  );
  const rejected = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential?agentId=agent_x", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "PUT",
    }),
    layer
  );
  const put = (credential: {
    readonly admin: boolean;
    readonly secret: string;
    readonly url: string | null;
  }) =>
    withDoor(
      directoryDoorFetch,
      new Request("https://door.internal/credential?agentId=agent_x", {
        body: JSON.stringify(credential),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      layer
    );
  await put({ admin: false, secret: "one", url: null });
  const first = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential?agentId=agent_x"),
    layer
  );
  await put({ admin: true, secret: "two", url: "https://example.com/hook" });
  const second = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential?agentId=agent_x"),
    layer
  );
  const empty = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/"),
    layer
  );
  await provideLayer(
    execRows(
      "CREATE TABLE agents (id TEXT, display_name TEXT, kind TEXT, admin INTEGER, token_hash TEXT, webhook_url TEXT, webhook_secret TEXT)",
      [],
      "seed"
    ),
    layer
  );
  await provideLayer(
    execRows(
      "INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret) VALUES (?, 'human', 'human', 1, 'hash', 'https://example.com/hook', 'whsec')",
      [agentId],
      "seed"
    ),
    layer
  );
  const seeded = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/"),
    layer
  );
  const marked = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/mark", { method: "POST" }),
    layer
  );
  const done = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/"),
    layer
  );
  expect(await bodyOf(missing)).toEqual({ ok: false });
  expect(await bodyOf(absent)).toEqual({ credential: null });
  expect(await bodyOf(rejected)).toEqual({ ok: false });
  expect(await bodyOf(first)).toEqual({
    credential: { admin: false, secret: "one", url: null },
  });
  expect(await bodyOf(second)).toEqual({
    credential: { admin: true, secret: "two", url: "https://example.com/hook" },
  });
  expect(await bodyOf(empty)).toEqual({ migrated: false, snapshot: null });
  const snapshot = Schema.decodeUnknownSync(AgentSnapshot)(
    await bodyOf(seeded)
  );
  expect(snapshot.migrated).toBe(false);
  expect(snapshot.snapshot?.agents[0]?.displayName).toBe("human");
  expect(snapshot.snapshot?.agents[0]?.tokenHash).toBe("hash");
  expect(await bodyOf(marked)).toEqual({ ok: true });
  expect(await bodyOf(done)).toEqual({ migrated: true, snapshot: null });
});

test("the room door publishes, closes one socket, and imports one snapshot", async () => {
  serverSockets.length = 0;
  const restore = installPair();
  const layer = memoryLayer("room-door");
  const sessions: Parameters<typeof roomDoorFetch>[0] = new Map();
  const open = (id: string) =>
    withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/socket", {
        headers: { upgrade: "WebSocket", "x-agent-rooms-agent": id },
      }),
      layer
    );
  try {
    const denied = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/socket", {
        headers: { upgrade: "websocket" },
      }),
      layer
    );
    const lead = await open(agentId);
    const guest = await open("agent_cccccccccccccccccccccccc");
    const opened = sessions.size;
    const bad = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/publish", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      layer
    );
    expect(await bodyOf(bad)).toEqual({ ok: false });
    expect(serverSockets[0]?.sent).toEqual([]);
    expect(serverSockets[1]?.sent).toEqual([]);
    const published = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/publish", {
        body: JSON.stringify({ text: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      layer
    );
    expect(await bodyOf(published)).toEqual({ ok: true });
    expect(serverSockets[0]?.sent).toEqual(["hello"]);
    expect(serverSockets[1]?.sent).toEqual(["hello"]);
    const closed = await withDoor(
      roomDoorFetch(sessions),
      new Request(`https://door.internal/close?agentId=${agentId}`, {
        method: "POST",
      }),
      layer
    );
    expect(await bodyOf(closed)).toEqual({ agentId, ok: true });
    expect(serverSockets[0]?.closed).toEqual([{ code: 1000, reason: "left" }]);
    expect(serverSockets[1]?.closed).toEqual([]);
    expect(sessions.size).toBe(1);
    const again = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/publish", {
        body: JSON.stringify({ text: "after" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      layer
    );
    expect(await bodyOf(again)).toEqual({ ok: true });
    expect(serverSockets[0]?.sent).toEqual(["hello"]);
    expect(serverSockets[1]?.sent).toEqual(["hello", "after"]);
    const unnamed = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/"),
      layer
    );
    expect(HttpServerResponse.toWeb(denied).status).toBe(401);
    expect(await textOf(denied)).toBe(
      "Sign in before opening the room socket."
    );
    expect(HttpServerResponse.toWeb(lead).status).toBe(101);
    expect(HttpServerResponse.toWeb(guest).status).toBe(101);
    expect(opened).toBe(2);
    expect(await bodyOf(unnamed)).toEqual({
      migrated: false,
      roomId: "",
      snapshot: null,
    });
  } finally {
    restore();
  }
  await provideLayer(
    execRows(
      "CREATE TABLE room_flags (id INTEGER PRIMARY KEY, name TEXT, topic TEXT, lead_id TEXT, hop_count INTEGER, paused INTEGER)",
      [],
      "seed"
    ),
    layer
  );
  await provideLayer(
    execRows(
      "CREATE TABLE members (agent_id TEXT PRIMARY KEY, display_name TEXT, kind TEXT, role TEXT, joined INTEGER, last_read_seq INTEGER, webhook_secret TEXT, webhook_url TEXT)",
      [],
      "seed"
    ),
    layer
  );
  await provideLayer(
    execRows(
      "CREATE TABLE messages (seq INTEGER PRIMARY KEY, author_id TEXT, author_kind TEXT, author_name TEXT, body TEXT, created_at INTEGER, mentions_json TEXT, redacted INTEGER, reply_to INTEGER, thread_root INTEGER)",
      [],
      "seed"
    ),
    layer
  );
  await provideLayer(
    execRows(
      "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, 'ops', 'delivery', ?, 4, 0)",
      [agentId],
      "seed"
    ),
    layer
  );
  const seeded = await withDoor(
    roomDoorFetch(sessions),
    new Request(`https://door.internal/?roomId=${roomId}`),
    layer
  );
  const marked = await withDoor(
    roomDoorFetch(sessions),
    new Request(`https://door.internal/mark?roomId=${roomId}`, {
      method: "POST",
    }),
    layer
  );
  const done = await withDoor(
    roomDoorFetch(sessions),
    new Request(`https://door.internal/?roomId=${roomId}`),
    layer
  );
  const snapshot = Schema.decodeUnknownSync(RoomSnapshot)(await bodyOf(seeded));
  expect(snapshot.migrated).toBe(false);
  expect(snapshot.snapshot?.hopCount).toBe(4);
  expect(snapshot.snapshot?.name).toBe("ops");
  expect(await bodyOf(marked)).toEqual({ ok: true });
  expect(await bodyOf(done)).toEqual({ migrated: true, snapshot: null });
});

test("an unnamed room read stays empty after flags exist", async () => {
  const layer = memoryLayer("room-door-unnamed");
  const sessions: Parameters<typeof roomDoorFetch>[0] = new Map();
  await provideLayer(
    execRows(
      "CREATE TABLE room_flags (id INTEGER PRIMARY KEY, name TEXT, topic TEXT, lead_id TEXT, hop_count INTEGER, paused INTEGER)",
      [],
      "seed"
    ),
    layer
  );
  await provideLayer(
    execRows(
      "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, 'ops', 'delivery', ?, 4, 0)",
      [agentId],
      "seed"
    ),
    layer
  );
  const unnamed = await withDoor(
    roomDoorFetch(sessions),
    new Request("https://door.internal/"),
    layer
  );
  const closed = await withDoor(
    roomDoorFetch(sessions),
    new Request("https://door.internal/close", { method: "POST" }),
    layer
  );
  expect(await bodyOf(unnamed)).toEqual({
    migrated: false,
    roomId: "",
    snapshot: null,
  });
  expect(await bodyOf(closed)).toEqual({ agentId: "", ok: true });
});

test("the room door rejects a blank agent, a plain upgrade, and a nameless publish", async () => {
  const restore = installPair();
  const layer = memoryLayer("room-door-reject");
  const sessions: Parameters<typeof roomDoorFetch>[0] = new Map();
  try {
    const blank = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/socket", {
        headers: { upgrade: "websocket", "x-agent-rooms-agent": "" },
      }),
      layer
    );
    const plain = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/socket", {
        headers: { upgrade: "nope" },
      }),
      layer
    );
    const published = await withDoor(
      roomDoorFetch(sessions),
      new Request("https://door.internal/publish", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      layer
    );
    expect(HttpServerResponse.toWeb(blank).status).toBe(401);
    expect(await textOf(blank)).toBe("Sign in before opening the room socket.");
    expect(await bodyOf(plain)).toEqual({
      migrated: false,
      roomId: "",
      snapshot: null,
    });
    expect(await bodyOf(published)).toEqual({ ok: false });
  } finally {
    restore();
  }
});

test("the directory door rejects an incomplete credential and confirms the write", async () => {
  const layer = memoryLayer("directory-door-edge");
  const incomplete = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential?agentId=ada", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "PUT",
    }),
    layer
  );
  const saved = await withDoor(
    directoryDoorFetch,
    new Request("https://door.internal/credential?agentId=ada", {
      body: JSON.stringify({ admin: false, secret: "s", url: null }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    }),
    layer
  );
  expect(await bodyOf(incomplete)).toEqual({ ok: false });
  expect(await bodyOf(saved)).toEqual({ ok: true });
});

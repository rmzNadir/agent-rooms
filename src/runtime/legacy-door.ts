import {
  DurableObject,
  upgrade as upgradeWebSocket,
  type WebSocket,
} from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { at } from "../boundary/external.ts";
import {
  alreadyMigrated,
  credentialRows,
  markMigrated,
  readDirectoryTables,
  readRoomTables,
} from "./legacy-store.ts";

const json = (body: object) => HttpServerResponse.jsonUnsafe(body);

const pathOf = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return new URL(request.url, "https://door.internal");
});

const CredentialBody = Schema.Struct({
  admin: Schema.Boolean,
  secret: Schema.String,
  url: Schema.NullOr(Schema.String),
});

const credential = Effect.gen(function* () {
  const url = yield* pathOf;
  const agentId = url.searchParams.get("agentId") ?? "";
  if (agentId.length === 0) {
    return json({ ok: false });
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method === "PUT") {
    const parsed = yield* Effect.result(
      HttpServerRequest.schemaBodyJson(CredentialBody)
    );
    if (parsed._tag === "Failure") {
      return json({ ok: false });
    }
    yield* credentialRows.put(agentId, parsed.success);
    return json({ ok: true });
  }
  const stored = yield* credentialRows.get(agentId);
  return json({ credential: stored ?? null });
});

export const directoryDoorFetch = Effect.gen(function* () {
  const url = yield* pathOf;
  if (url.pathname === "/credential") {
    return yield* credential;
  }
  if (url.pathname === "/mark") {
    yield* markMigrated;
    return json({ ok: true });
  }
  const migrated = yield* alreadyMigrated;
  if (migrated) {
    return json({ migrated: true, snapshot: null });
  }
  return json({
    migrated: false,
    snapshot: (yield* readDirectoryTables) ?? null,
  });
});

interface LiveSocket {
  readonly agentId: string;
  readonly socket: WebSocket;
}

const socketText = (body: string, status: number) =>
  HttpServerResponse.text(body, { status });

const acceptSocket = (sessions: Map<string, LiveSocket>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = at(request.headers, "x-agent-rooms-agent");
    if (typeof header !== "string" || header.length === 0) {
      return socketText("Sign in before opening the room socket.", 401);
    }
    const [response, socket] = yield* upgradeWebSocket();
    sessions.set(crypto.randomUUID(), { agentId: header, socket });
    return response;
  });

const closeSockets = (sessions: Map<string, LiveSocket>, agentId: string) =>
  Effect.gen(function* () {
    for (const [id, session] of sessions) {
      if (session.agentId === agentId) {
        yield* session.socket.close(1000, "left");
        sessions.delete(id);
      }
    }
  });

const publishSockets = (sessions: Map<string, LiveSocket>, text: string) =>
  Effect.gen(function* () {
    for (const session of sessions.values()) {
      yield* session.socket.send(text);
    }
  });

const PublishBody = Schema.Struct({ text: Schema.String });

export const roomDoorFetch = (sessions: Map<string, LiveSocket>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const upgrade = at(request.headers, "upgrade");
    if (typeof upgrade === "string" && upgrade.toLowerCase() === "websocket") {
      return yield* acceptSocket(sessions);
    }
    const url = new URL(request.url, "https://door.internal");
    if (url.pathname === "/close") {
      const agentId = url.searchParams.get("agentId") ?? "";
      yield* closeSockets(sessions, agentId);
      return json({ agentId, ok: true });
    }
    if (url.pathname === "/publish") {
      const parsed = yield* Effect.result(
        HttpServerRequest.schemaBodyJson(PublishBody)
      );
      if (parsed._tag === "Failure") {
        return json({ ok: false });
      }
      yield* publishSockets(sessions, parsed.success.text);
      return json({ ok: true });
    }
    const roomId = url.searchParams.get("roomId") ?? "";
    if (url.pathname === "/mark") {
      yield* markMigrated;
      return json({ ok: true });
    }
    if (roomId.length === 0) {
      return json({ migrated: false, roomId, snapshot: null });
    }
    const migrated = yield* alreadyMigrated;
    if (migrated) {
      return json({ migrated: true, snapshot: null });
    }
    return json({
      migrated: false,
      snapshot: (yield* readRoomTables(roomId)) ?? null,
    });
  });

export const buildDirectoryDoor = Effect.succeed(
  Effect.succeed({ fetch: directoryDoorFetch })
);

export const buildRoomDoor = Effect.succeed(
  Effect.sync(() => {
    const sessions = new Map<string, LiveSocket>();
    return { fetch: roomDoorFetch(sessions) };
  })
);

export const directoryClassName = "DirectoryServer";
export const roomClassName = "RoomServer";

export class DirectoryServer extends DurableObject<DirectoryServer>()(
  directoryClassName,
  buildDirectoryDoor
) {}

export class RoomServer extends DurableObject<RoomServer>()(
  roomClassName,
  buildRoomDoor
) {}

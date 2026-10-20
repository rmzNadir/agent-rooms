import { Effect, Layer, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { client } from "../model/client.ts";
import { Directory } from "../model/directory.ts";
import { Room } from "../model/room.ts";
import { CredentialBook, LegacyImport } from "./credentials.ts";
import type { DirectoryHandle, RoomHandle } from "./legacy-apply.ts";
import {
  decodeDirectoryBody,
  decodeRoomBody,
  importDirectorySnapshot,
  importRoomSnapshot,
} from "./legacy-run.ts";
import { RoomSockets } from "./sockets.ts";

interface DoorStub {
  readonly fetch: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

export interface DoorNamespace {
  readonly getByName: (name: string) => DoorStub;
}

const directoryName = "directory";

const ask = (
  namespace: DoorNamespace,
  name: string,
  path: string,
  init?: { readonly body?: string; readonly method: string }
) =>
  Effect.gen(function* () {
    const method = init?.method ?? "GET";
    const request = HttpServerRequest.fromWeb(
      new Request(`https://door.internal${path}`, {
        body: init?.body,
        headers:
          init?.body === undefined
            ? { "x-door-method": method, "x-door-path": path }
            : {
                "content-type": "application/json",
                "x-door-method": method,
                "x-door-path": path,
              },
        method,
      })
    );
    const response = yield* namespace.getByName(name).fetch(request);
    return yield* Effect.tryPromise({
      catch: () => "door" as const,
      try: () => HttpServerResponse.toWeb(response).json(),
    });
  }).pipe(
    Effect.catch((reason) =>
      Effect.die(`The legacy door did not answer. ${reason}`)
    )
  );

const CredentialResponse = Schema.Struct({
  credential: Schema.NullOr(
    Schema.Struct({
      admin: Schema.Boolean,
      secret: Schema.String,
      url: Schema.NullOr(Schema.String),
    })
  ),
});

const decodeCredential = Schema.decodeUnknownEffect(CredentialResponse);

export const doorCredentials = (directory: DoorNamespace) =>
  Layer.succeed(
    CredentialBook,
    CredentialBook.of({
      get: (agentId) =>
        Effect.gen(function* () {
          const payload = yield* ask(
            directory,
            directoryName,
            `/credential?agentId=${encodeURIComponent(agentId)}`
          );
          const decoded = yield* decodeCredential(payload).pipe(
            Effect.catchTag("SchemaError", () =>
              Effect.die("The credential door returned an unreadable body.")
            )
          );
          return decoded.credential ?? undefined;
        }),
      put: (agentId, credential) =>
        Effect.gen(function* () {
          yield* ask(
            directory,
            directoryName,
            `/credential?agentId=${encodeURIComponent(agentId)}`,
            {
              body: JSON.stringify(credential),
              method: "PUT",
            }
          );
        }),
    })
  );

const mark = (namespace: DoorNamespace, name: string) =>
  ask(namespace, name, "/mark", { method: "POST" }).pipe(Effect.asVoid);

export const doorLegacy = (directoryNs: DoorNamespace, roomNs: DoorNamespace) =>
  Layer.effect(
    LegacyImport,
    Effect.gen(function* () {
      const book = yield* CredentialBook;
      const directory = yield* client<DirectoryHandle>(Directory);
      const rooms = yield* client<RoomHandle>(Room);
      return LegacyImport.of({
        directory: () =>
          Effect.gen(function* () {
            const payload = yield* ask(directoryNs, directoryName, "/");
            const body = yield* decodeDirectoryBody(payload).pipe(
              Effect.catchTag("SchemaError", () =>
                Effect.die("The directory snapshot was unreadable.")
              )
            );
            yield* importDirectorySnapshot(
              body,
              mark(directoryNs, directoryName),
              book,
              directory
            ).pipe(Effect.orDie);
          }),
        room: (roomId) =>
          Effect.gen(function* () {
            const payload = yield* ask(
              roomNs,
              roomId,
              `/?roomId=${encodeURIComponent(roomId)}`
            );
            const body = yield* decodeRoomBody(payload).pipe(
              Effect.catchTag("SchemaError", () =>
                Effect.die("The room snapshot was unreadable.")
              )
            );
            yield* importRoomSnapshot(
              body,
              mark(roomNs, roomId),
              book,
              rooms
            ).pipe(Effect.orDie);
          }),
      });
    })
  );

export const doorSockets = (rooms: DoorNamespace) =>
  Layer.succeed(
    RoomSockets,
    RoomSockets.of({
      close: (roomId, agentId) =>
        ask(rooms, roomId, `/close?agentId=${encodeURIComponent(agentId)}`, {
          method: "POST",
        }).pipe(Effect.asVoid),
      open: (roomId, request) => rooms.getByName(roomId).fetch(request),
      publish: (roomId, text) =>
        ask(rooms, roomId, "/publish", {
          body: JSON.stringify({ text }),
          method: "POST",
        }).pipe(Effect.asVoid),
    })
  );

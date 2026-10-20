import { expect, test } from "bun:test";
import { Cause, Context, Effect, Layer, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { at } from "../src/boundary/external.ts";
import {
  CredentialBook,
  LegacyImport,
  memoryCredentials,
} from "../src/runtime/credentials.ts";
import { roomsInMemory } from "../src/runtime/domain-host.ts";
import {
  type DoorNamespace,
  doorCredentials,
  doorLegacy,
  doorSockets,
} from "../src/runtime/legacy-client.ts";
import { RoomSockets, socketsSkip } from "../src/runtime/sockets.ts";
import { buildIn, buildProvided, fulfill, runIn } from "./effect-run.ts";

const answer = (payload: object) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe(payload));

interface Seen {
  readonly bodies: string[];
  readonly notes: string[];
}

const recording = (
  respond: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>
): { readonly namespace: DoorNamespace; readonly seen: Seen } => {
  const seen: Seen = { bodies: [], notes: [] };
  const namespace: DoorNamespace = {
    getByName: (name) => ({
      fetch: (request) =>
        Effect.gen(function* () {
          seen.notes.push(
            `${name} ${request.method} ${request.url} ${request.originalUrl} door-method=${at(request.headers, "x-door-method") ?? ""} door-path=${at(request.headers, "x-door-path") ?? ""}`
          );
          seen.bodies.push(yield* request.text);
          const header = at(request.headers, "content-type");
          if (typeof header === "string") {
            seen.notes.push(header);
          }
          return yield* respond(request);
        }).pipe(Effect.orDie),
    }),
  };
  return { namespace, seen };
};

const openLegacy = async (
  directoryNs: DoorNamespace,
  roomNs: DoorNamespace
) => {
  const scope = await Effect.runPromise(Scope.make());
  const hosted = roomsInMemory().pipe(Layer.provide(memoryCredentials()));
  const base = await buildIn(
    Layer.mergeAll(hosted, memoryCredentials(), socketsSkip),
    scope
  );
  const legacy = await buildProvided(
    doorLegacy(directoryNs, roomNs),
    base,
    scope
  );
  const context = Context.merge(base, legacy);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runIn(effect, context, scope);
  return { run };
};

const directoryCall = Effect.gen(function* () {
  const legacy = yield* LegacyImport;
  yield* legacy.directory();
});

const roomCall = (roomId: string) =>
  Effect.gen(function* () {
    const legacy = yield* LegacyImport;
    yield* legacy.room(roomId);
  });

test("an already migrated directory is not marked again", async () => {
  const { namespace, seen } = recording(() =>
    answer({ migrated: true, snapshot: null })
  );
  const { run } = await openLegacy(namespace, namespace);
  await run(directoryCall);
  expect(seen.notes.some((note) => note.includes("/mark"))).toBe(false);
  expect(seen.notes[0]).toContain("directory");
  expect(seen.notes[0]).toContain("GET");
  expect(seen.notes[0]).toContain("https://door.internal/");
  expect(seen.notes[0]).toContain("door-method=GET");
  expect(seen.notes[0]).toContain("door-path=/");
  expect(seen.notes.includes("application/json")).toBe(false);
});

test("an empty directory snapshot is marked imported", async () => {
  const { namespace, seen } = recording(() =>
    answer({ migrated: false, snapshot: null })
  );
  const { run } = await openLegacy(namespace, namespace);
  await run(directoryCall);
  expect(seen.notes.some((note) => note.includes("POST"))).toBe(true);
  expect(seen.notes.some((note) => note.includes("/mark"))).toBe(true);
});

test("an empty room snapshot is marked and an imported room is not", async () => {
  const empty = recording(() => answer({ migrated: false, snapshot: null }));
  const done = recording(() => answer({ migrated: true, snapshot: null }));
  const first = await openLegacy(empty.namespace, empty.namespace);
  const second = await openLegacy(done.namespace, done.namespace);
  await first.run(roomCall("a/b"));
  await second.run(roomCall("a/b"));
  expect(empty.seen.notes.some((note) => note.includes("roomId=a%2Fb"))).toBe(
    true
  );
  expect(empty.seen.notes.some((note) => note.includes("/mark"))).toBe(true);
  expect(done.seen.notes.some((note) => note.includes("roomId=a%2Fb"))).toBe(
    true
  );
  expect(done.seen.notes.some((note) => note.includes("/mark"))).toBe(false);
});

test("an unreadable door dies with the door's own message", async () => {
  const directory = recording(() => answer({ migrated: false }));
  const room = recording(() =>
    answer({ migrated: false, snapshot: { name: "x" } })
  );
  const silent: DoorNamespace = {
    getByName: () => ({
      fetch: () => Effect.succeed(HttpServerResponse.text("nope")),
    }),
  };
  const directoryHost = await openLegacy(
    directory.namespace,
    directory.namespace
  );
  const roomHost = await openLegacy(room.namespace, room.namespace);
  const silentHost = await openLegacy(silent, silent);
  const directoryExit = await directoryHost.run(Effect.exit(directoryCall));
  const roomExit = await roomHost.run(Effect.exit(roomCall("room_a")));
  const silentExit = await silentHost.run(Effect.exit(directoryCall));
  expect(directoryExit._tag).toBe("Failure");
  expect(roomExit._tag).toBe("Failure");
  expect(silentExit._tag).toBe("Failure");
  if (
    directoryExit._tag === "Failure" &&
    roomExit._tag === "Failure" &&
    silentExit._tag === "Failure"
  ) {
    expect(Cause.pretty(directoryExit.cause)).toContain(
      "The directory snapshot was unreadable."
    );
    expect(Cause.pretty(roomExit.cause)).toContain(
      "The room snapshot was unreadable."
    );
    expect(Cause.pretty(silentExit.cause)).toContain(
      "The legacy door did not answer. door"
    );
  }
});

test("credential get and put keep the stored secret", async () => {
  const stored = recording(() =>
    answer({ credential: { admin: true, secret: "s", url: null } })
  );
  const missing = recording(() => answer({ credential: null }));
  const broken = recording(() => answer({ credential: { admin: "yes" } }));
  const writer = recording(() => answer({ ok: true }));
  const read = (namespace: DoorNamespace) =>
    fulfill(
      Effect.gen(function* () {
        const book = yield* CredentialBook;
        return yield* book.get("a/b");
      }).pipe(Effect.provide(doorCredentials(namespace)))
    );
  const value = await read(stored.namespace);
  const empty = await read(missing.namespace);
  const exit = await fulfill(
    Effect.exit(
      Effect.gen(function* () {
        const book = yield* CredentialBook;
        return yield* book.get("a/b");
      }).pipe(Effect.provide(doorCredentials(broken.namespace)))
    )
  );
  await fulfill(
    Effect.gen(function* () {
      const book = yield* CredentialBook;
      yield* book.put("a/b", {
        admin: true,
        secret: "s",
        url: "https://example.com/hook",
      });
    }).pipe(Effect.provide(doorCredentials(writer.namespace)))
  );
  expect(value).toEqual({ admin: true, secret: "s", url: null });
  expect(empty).toBeUndefined();
  expect(stored.seen.notes[0]).toContain("agentId=a%2Fb");
  expect(stored.seen.notes[0]).toContain("directory");
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    expect(Cause.pretty(exit.cause)).toContain(
      "The credential door returned an unreadable body."
    );
  }
  expect(writer.seen.bodies[0]).toBe(
    JSON.stringify({
      admin: true,
      secret: "s",
      url: "https://example.com/hook",
    })
  );
  expect(writer.seen.notes).toContain("application/json");
  expect(writer.seen.notes[0]).toContain("PUT");
});

test("room sockets close, publish, and open through the room door", async () => {
  const { namespace, seen } = recording(() => answer({ ok: true }));
  const status = await fulfill(
    Effect.gen(function* () {
      const sockets = yield* RoomSockets;
      yield* sockets.close("room a/b", "a/b");
      yield* sockets.publish("room a/b", "hello");
      const response = yield* sockets.open(
        "room a/b",
        HttpServerRequest.fromWeb(new Request("https://door.internal/socket"))
      );
      return HttpServerResponse.toWeb(response).status;
    }).pipe(Effect.provide(doorSockets(namespace)))
  );
  expect(status).toBe(200);
  expect(seen.notes.some((note) => note.includes("agentId=a%2Fb"))).toBe(true);
  expect(seen.notes.some((note) => note.startsWith("room a/b"))).toBe(true);
  expect(seen.bodies).toContain(JSON.stringify({ text: "hello" }));
  expect(seen.notes).toContain("application/json");
  expect(seen.notes.some((note) => note.includes("POST /close"))).toBe(true);
  expect(seen.notes.some((note) => note.includes("POST /publish"))).toBe(true);
});

import { expect, test } from "bun:test";
import { Cause, Effect, Layer, Scope } from "effect";
import { client } from "../src/model/client.ts";
import { Directory } from "../src/model/directory.ts";
import type { LegacyDirectory, LegacyRoomInput } from "../src/model/migrate.ts";
import { Room } from "../src/model/room.ts";
import type { RoomState } from "../src/model/room-shape.ts";
import type { StoredCredential } from "../src/runtime/credentials.ts";
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
  type SecretBook,
} from "../src/runtime/legacy-apply.ts";
import {
  alreadyMigrated,
  credentialRows,
  markMigrated,
  readDirectoryTables,
  readRoomTables,
} from "../src/runtime/legacy-store.ts";
import { socketsSkip } from "../src/runtime/sockets.ts";
import { buildIn, fulfill, provideLayer, runIn } from "./effect-run.ts";
import {
  agentCount,
  bareDirectory,
  bot,
  createMigrated,
  directoryAdmins,
  directoryCredential,
  expectedDirectory,
  expectedRoom,
  ghost,
  hop,
  human,
  kept,
  member,
  messageBodies,
  messageCount,
  outsideDirectory,
  roomA,
  roomCredential,
  roomOnly,
  seedDirectory,
  seedEmptyFlags,
  seedFlagRow,
  seedMention,
  seedRoom,
  solo,
  statement,
  tokenList,
} from "./legacy-rows-fixture.ts";
import { asService, memoryLayer } from "./sqlite-state.ts";

const defined = <A>(value: A | undefined): A => {
  if (value === undefined) {
    throw new Error("legacy tables did not decode");
  }
  return value;
};

const defectText = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  fulfill(
    Effect.matchCause(effect, {
      onFailure: (cause) => Cause.pretty(cause),
      onSuccess: () => "ok",
    }) as Effect.Effect<string, never, never>
  );

const pick = <A>(states: readonly A[], index: number): A => {
  const found = states[index];
  if (found !== undefined) {
    return found;
  }
  const last = states.at(-1);
  if (last !== undefined) {
    return last;
  }
  throw new Error("missing scripted state");
};

const scripted = <A>(states: readonly A[]) => {
  let index = 0;
  const sends: number[] = [];
  return {
    send: () =>
      Effect.sync(() => {
        sends.push(1);
      }),
    sends,
    state: () => {
      const current = pick(states, index);
      index += 1;
      return Effect.succeed(current);
    },
  };
};

interface HashAgent {
  readonly agentId: string;
  readonly tokenHash: string;
}

const directoryScript = (
  states: readonly { readonly agents: readonly HashAgent[] }[]
) => {
  const tape = scripted(states);
  const handle: DirectoryHandle = {
    send: () => tape.send(),
    state: () => tape.state(),
  };
  return { handle, sends: tape.sends };
};

interface RoomView {
  readonly hopCount: number;
  readonly messages: readonly { readonly seq: number }[];
  readonly open: boolean;
}

const roomView = (
  open: boolean,
  count: number,
  hopCount: number
): RoomView => ({
  hopCount,
  messages: Array.from({ length: count }, (_item, seq) => ({ seq })),
  open,
});

const roomScript = (states: readonly RoomView[]) => {
  const tape = scripted(states);
  const handle: RoomHandle = {
    send: () => tape.send(),
    state: () => tape.state(),
  };
  return { handle, sends: tape.sends };
};

const memoryBook = () => {
  const rows = new Map<string, StoredCredential>();
  const book: SecretBook = {
    get: (agentId) => Effect.succeed(rows.get(agentId)),
    put: (agentId, credential) =>
      Effect.sync(() => rows.set(agentId, credential)),
  };
  return { book, rows };
};

const openSql = (name: string) => {
  const sql = memoryLayer(name);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provideLayer(effect, sql);
  const die = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    defectText(
      effect.pipe(Effect.provide(sql)) as Effect.Effect<A, never, never>
    );
  return { die, run };
};

const tokensOf = (snapshot: LegacyDirectory): readonly HashAgent[] =>
  snapshot.agents.map((agent) => ({
    agentId: agent.agentId,
    tokenHash: agent.tokenHash,
  }));

const withHash = (
  rows: readonly HashAgent[],
  agentId: string,
  tokenHash: string
) =>
  rows.map((agent) => ({
    agentId: agent.agentId,
    tokenHash: agent.agentId === agentId ? tokenHash : agent.tokenHash,
  }));

const bodiesOf = (rows: readonly { readonly body: string }[]) =>
  rows.map((message) => message.body);

const adminsOf = (rows: readonly { readonly admin?: boolean }[]) =>
  rows.map((agent) => agent.admin);

const hashesOf = (rows: readonly { readonly tokenHash: string }[]) =>
  rows.map((agent) => agent.tokenHash);

const membersAt = (rooms: LegacyDirectory["rooms"], index: number) =>
  rooms[index]?.members ?? [];

const keptSecret: StoredCredential = {
  admin: false,
  secret: "sec-kept",
  url: "http://old",
};

const hosted = roomsInMemory().pipe(Layer.provide(memoryCredentials()));
const baseLayer = Layer.mergeAll(
  memoryCredentials(),
  legacySkip,
  socketsSkip,
  hosted
);

test("directory tables keep both kinds, roles, admins, and null text", async () => {
  const db = openSql("directory-rows");
  await db.run(seedDirectory);
  expect(await db.run(readDirectoryTables)).toEqual(expectedDirectory);
});

test("room tables keep reactions, pause, replies, threads, and redaction", async () => {
  const paused = openSql("room-paused");
  const running = openSql("room-running");
  await paused.run(seedRoom(1));
  await running.run(seedRoom(0));
  expect(await paused.run(readRoomTables(roomA))).toEqual(expectedRoom(1));
  expect(await running.run(readRoomTables(roomA))).toEqual(expectedRoom(0));
});

test("missing legacy tables and an empty flag row stay unread", async () => {
  const bare = openSql("bare");
  const flags = openSql("flags-empty");
  const flagged = openSql("flags-only");
  await flags.run(seedEmptyFlags);
  await flagged.run(seedFlagRow);
  expect(await bare.run(readDirectoryTables)).toBeUndefined();
  expect(await bare.run(readRoomTables(roomA))).toBeUndefined();
  expect(await flags.run(readRoomTables(roomA))).toBeUndefined();
  expect(await flagged.die(readRoomTables(roomA))).toContain(
    "The legacy tables could not be read. legacy"
  );
});

test("a migration flag is false until markMigrated writes it", async () => {
  const fresh = openSql("migrate-fresh");
  const zero = openSql("migrate-zero");
  const empty = openSql("migrate-empty");
  const marked = openSql("migrate-marked");
  await zero.run(createMigrated);
  await zero.run(
    statement("INSERT INTO domain_migrated (id, done) VALUES (1, 0)")
  );
  await empty.run(createMigrated);
  await marked.run(markMigrated);
  expect(await fresh.run(alreadyMigrated)).toBe(false);
  expect(await zero.run(alreadyMigrated)).toBe(false);
  expect(await empty.run(alreadyMigrated)).toBe(false);
  expect(await marked.run(alreadyMigrated)).toBe(true);
});

test("bad mention json dies and credential blanks stay null", async () => {
  const broken = openSql("mentions-broken");
  const numbers = openSql("mentions-numbers");
  const creds = openSql("credentials");
  const absent = openSql("credentials-absent");
  await broken.run(seedMention("not-json"));
  await numbers.run(seedMention("[1]"));
  await creds.run(
    credentialRows.put(human, { admin: true, secret: "sec", url: "" })
  );
  await creds.run(
    credentialRows.put(bot, {
      admin: false,
      secret: "sec-bot",
      url: "http://bot",
    })
  );
  expect(await broken.die(readRoomTables(roomA))).toContain("mentions");
  expect(await numbers.die(readRoomTables(roomA))).toContain("mentions");
  expect(await creds.run(credentialRows.get(roomOnly))).toBeUndefined();
  expect(await creds.run(credentialRows.get(human))).toEqual({
    admin: true,
    secret: "sec",
    url: null,
  });
  expect(await creds.run(credentialRows.get(bot))).toEqual({
    admin: false,
    secret: "sec-bot",
    url: "http://bot",
  });
  expect(await absent.run(credentialRows.get(human))).toBeUndefined();
});

test("apply keeps hashes, admins, hop, and does not duplicate", async () => {
  const directoryDb = openSql("apply-directory");
  const roomDb = openSql("apply-room");
  await directoryDb.run(seedDirectory);
  await roomDb.run(seedRoom(1));
  const directorySnapshot = defined(await directoryDb.run(readDirectoryTables));
  const roomSnapshot = defined(await roomDb.run(readRoomTables(roomA)));
  const scope = await fulfill(Scope.make());
  const context = await buildIn(baseLayer, scope);
  const imported = await runIn(
    Effect.gen(function* () {
      const directory = yield* client<DirectoryHandle>(Directory);
      const rooms = yield* client<RoomHandle>(Room);
      const book = yield* CredentialBook;
      yield* book.put(kept, keptSecret);
      yield* applyDirectory(directorySnapshot, book, directory);
      yield* applyRoom(roomSnapshot, book, rooms);
      yield* applyDirectory(directorySnapshot, book, directory);
      yield* applyRoom(roomSnapshot, book, rooms);
      const listed = (yield* directory.state("directory")) as {
        readonly agents: readonly {
          readonly admin?: boolean;
          readonly tokenHash: string;
        }[];
      };
      const room = asService<RoomState>(yield* rooms.state(roomA));
      return {
        bot: yield* book.get(bot),
        ghost: yield* book.get(ghost),
        human: yield* book.get(human),
        kept: yield* book.get(kept),
        listed,
        member: yield* book.get(member),
        only: yield* book.get(roomOnly),
        room,
        solo: yield* book.get(solo),
      };
    }),
    context,
    scope
  );
  expect(imported.listed.agents).toHaveLength(agentCount);
  expect(hashesOf(imported.listed.agents)).toEqual(tokenList);
  expect(adminsOf(imported.listed.agents)).toEqual(directoryAdmins);
  expect(imported.human).toEqual(directoryCredential(human));
  expect(imported.member).toEqual(directoryCredential(member));
  expect(imported.solo).toEqual(directoryCredential(solo));
  expect(imported.bot).toEqual(directoryCredential(bot));
  expect(imported.ghost).toBeUndefined();
  expect(imported.kept).toEqual(keptSecret);
  expect(imported.only).toEqual(roomCredential(roomOnly));
  expect(imported.room.hopCount).toBe(hop);
  expect(imported.room.messages).toHaveLength(messageCount);
  expect(bodiesOf(imported.room.messages)).toEqual(messageBodies);
  expect(imported.room.paused).toBe(true);
});

test("two agents and a mismatched hash die", async () => {
  const db = openSql("hash-mismatch");
  await db.run(seedDirectory);
  const snapshot = defined(await db.run(readDirectoryTables));
  const text = await defectText(
    applyDirectory(
      snapshot,
      memoryBook().book,
      directoryScript([
        { agents: withHash(tokensOf(snapshot), human, "hash-nope") },
      ]).handle
    )
  );
  expect(text).toContain("Imported token hashes did not match.");
});

test("an extra imported agent dies when the hash length differs", async () => {
  const db = openSql("hash-length");
  await db.run(seedDirectory);
  const snapshot = defined(await db.run(readDirectoryTables));
  const text = await defectText(
    applyDirectory(
      snapshot,
      memoryBook().book,
      directoryScript([
        {
          agents: [
            ...tokensOf(snapshot),
            { agentId: roomOnly, tokenHash: "hash-extra" },
          ],
        },
      ]).handle
    )
  );
  expect(text).toContain("Imported token hashes did not match.");
});

test("directory send runs only for an empty log with something to import", async () => {
  const full = openSql("send-full");
  const agentsOnly = openSql("send-agents");
  const roomsOnly = openSql("send-rooms");
  await full.run(seedDirectory);
  await agentsOnly.run(seedDirectory);
  await agentsOnly.run(statement("DROP TABLE rooms"));
  await agentsOnly.run(statement("DROP TABLE memberships"));
  await roomsOnly.run(seedDirectory);
  await roomsOnly.run(statement("DELETE FROM agents"));
  const snapshot = defined(await full.run(readDirectoryTables));
  const agentSnapshot = defined(await agentsOnly.run(readDirectoryTables));
  const roomSnapshot = defined(await roomsOnly.run(readDirectoryTables));
  const populated = directoryScript([{ agents: tokensOf(snapshot) }]);
  const empty = directoryScript([{ agents: [] }]);
  const agentsFirst = directoryScript([
    { agents: [] },
    { agents: tokensOf(agentSnapshot) },
  ]);
  const roomsFirst = directoryScript([{ agents: [] }]);
  await fulfill(applyDirectory(snapshot, memoryBook().book, populated.handle));
  await fulfill(
    applyDirectory({ agents: [], rooms: [] }, memoryBook().book, empty.handle)
  );
  await fulfill(
    applyDirectory(agentSnapshot, memoryBook().book, agentsFirst.handle)
  );
  await fulfill(
    applyDirectory(roomSnapshot, memoryBook().book, roomsFirst.handle)
  );
  expect(populated.sends).toHaveLength(0);
  expect(empty.sends).toHaveLength(0);
  expect(agentsFirst.sends).toHaveLength(1);
  expect(roomsFirst.sends).toHaveLength(1);
  expect(agentSnapshot.rooms).toEqual([]);
  expect(roomSnapshot.agents).toEqual([]);
  expect(roomSnapshot.rooms).toHaveLength(2);
  expect(membersAt(roomSnapshot.rooms, 0)).toEqual([]);
  expect(membersAt(roomSnapshot.rooms, 1)).toEqual([]);
});

test("room counts die on either side and a second apply does not resend", async () => {
  const db = openSql("room-counts");
  await db.run(seedRoom(1));
  const snapshot = defined(await db.run(readRoomTables(roomA)));
  const countText = await dieRoom(snapshot, true, 0, hop);
  const hopText = await dieRoom(snapshot, true, messageCount, 0);
  const once = roomScript([
    roomView(false, 0, 0),
    roomView(true, messageCount, hop),
    roomView(true, messageCount, hop),
  ]);
  const book = memoryBook();
  await fulfill(applyRoom(snapshot, book.book, once.handle));
  await fulfill(applyRoom(snapshot, book.book, once.handle));
  expect(countText).toContain("Imported room counts did not match.");
  expect(hopText).toContain("Imported room counts did not match.");
  expect(once.sends).toHaveLength(1);
  expect(book.rows.get(roomOnly)).toEqual(roomCredential(roomOnly));
  expect(book.rows.get(human)).toEqual(roomCredential(human));
});

const dieRoom = (
  snapshot: LegacyRoomInput,
  open: boolean,
  count: number,
  hopCount: number
) =>
  defectText(
    applyRoom(
      snapshot,
      memoryBook().book,
      roomScript([roomView(open, count, hopCount)]).handle
    )
  );

test("omitted webhook fields and a room-only member stay admin false", async () => {
  const bareBook = memoryBook();
  const outsideBook = memoryBook();
  const bareHandle = directoryScript([
    {
      agents: [
        { agentId: bot, tokenHash: "hash-bot" },
        { agentId: ghost, tokenHash: "hash-ghost" },
      ],
    },
  ]);
  const outsideHandle = directoryScript([{ agents: [] }]);
  await fulfill(
    applyDirectory(bareDirectory(), bareBook.book, bareHandle.handle)
  );
  await fulfill(
    applyDirectory(outsideDirectory(), outsideBook.book, outsideHandle.handle)
  );
  expect(bareBook.rows.get(bot)).toEqual({
    admin: false,
    secret: "sec-bot",
    url: null,
  });
  expect(bareBook.rows.get(ghost)).toBeUndefined();
  expect(outsideBook.rows.get(roomOnly)).toEqual({
    admin: false,
    secret: "sec-only",
    url: null,
  });
});

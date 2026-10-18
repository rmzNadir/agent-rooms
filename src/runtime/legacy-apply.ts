import { Effect, Schema } from "effect";
import { AgentId, RoomId } from "../domain/ids.ts";
import { RegisterImported } from "../model/directory.ts";
import {
  importPlan,
  type LegacyDirectory,
  type LegacyRoomInput,
  plannedRoom,
} from "../model/migrate.ts";
import { RecordImport } from "../model/room-commands.ts";
import type { StoredCredential } from "./credentials.ts";

interface HashAgent {
  readonly agentId: string;
  readonly tokenHash: string;
}

export interface DirectoryHandle {
  readonly send: (
    id: string,
    command: object
  ) => Effect.Effect<void, { readonly _tag: string }>;
  readonly state: (id: string) => Effect.Effect<{
    readonly agents: readonly HashAgent[];
  }>;
}

export interface RoomHandle {
  readonly send: (
    id: string,
    command: object
  ) => Effect.Effect<void, { readonly _tag: string }>;
  readonly state: (id: string) => Effect.Effect<{
    readonly hopCount: number;
    readonly messages: readonly { readonly seq: number }[];
    readonly open: boolean;
  }>;
}

export interface SecretBook {
  readonly get: (
    agentId: string
  ) => Effect.Effect<StoredCredential | undefined>;
  readonly put: (
    agentId: string,
    credential: StoredCredential
  ) => Effect.Effect<void>;
}

const directoryTarget = "directory";
const brandAgent = Schema.decodeUnknownSync(AgentId);
const brandRoom = Schema.decodeUnknownSync(RoomId);

export const sameCredential = (left: HashAgent, right: HashAgent) =>
  left.agentId === right.agentId && left.tokenHash === right.tokenHash;

export const hashesMatch = (
  tokens: readonly HashAgent[],
  agents: readonly HashAgent[]
) =>
  tokens.length === agents.length &&
  tokens.every((token) => agents.some((agent) => sameCredential(agent, token)));

const copySecret = (
  book: SecretBook,
  secret: {
    readonly agentId: string;
    readonly webhookSecret: string;
    readonly webhookUrl: string;
  },
  admin: boolean
) =>
  Effect.gen(function* () {
    const existing = yield* book.get(secret.agentId);
    if (existing !== undefined) {
      return;
    }
    const url = secret.webhookUrl.length === 0 ? null : secret.webhookUrl;
    yield* book.put(secret.agentId, {
      admin,
      secret: secret.webhookSecret,
      url,
    });
  });

export const applyDirectory = (
  snapshot: LegacyDirectory,
  book: SecretBook,
  directory: DirectoryHandle
) =>
  Effect.gen(function* () {
    const plan = importPlan(snapshot);
    const current = yield* directory.state(directoryTarget);
    if (
      current.agents.length === 0 &&
      (snapshot.agents.length > 0 || snapshot.rooms.length > 0)
    ) {
      yield* directory.send(
        directoryTarget,
        new RegisterImported({
          agents: snapshot.agents.map((agent) => ({
            admin: agent.admin === true,
            agentId: brandAgent(agent.agentId),
            displayName: agent.displayName,
            kind: agent.kind,
            tokenHash: agent.tokenHash,
          })),
          rooms: snapshot.rooms.map((room) => ({
            leadId: brandAgent(room.leadId),
            name: room.name,
            roomId: brandRoom(room.roomId),
            topic: room.topic,
          })),
        })
      );
    }
    const imported = yield* directory.state(directoryTarget);
    if (!hashesMatch(plan.tokens, imported.agents)) {
      return yield* Effect.die("Imported token hashes did not match.");
    }
    for (const secret of plan.secrets) {
      const agent = snapshot.agents.find(
        (item) => item.agentId === secret.agentId
      );
      yield* copySecret(book, secret, agent?.admin === true);
    }
    for (const agent of snapshot.agents) {
      if (
        agent.webhookSecret === undefined ||
        agent.webhookSecret.length === 0
      ) {
        continue;
      }
      yield* copySecret(
        book,
        {
          agentId: agent.agentId,
          webhookSecret: agent.webhookSecret,
          webhookUrl: agent.webhookUrl ?? "",
        },
        agent.admin === true
      );
    }
  });

export const roomOnly = (snapshot: LegacyRoomInput) => ({
  agents: [] as LegacyDirectory["agents"],
  rooms: [snapshot],
});

export const applyRoom = (
  snapshot: LegacyRoomInput,
  book: SecretBook,
  rooms: RoomHandle
) =>
  Effect.gen(function* () {
    const plan = importPlan(roomOnly(snapshot));
    const planned = plannedRoom(plan.rooms);
    const current = yield* rooms.state(snapshot.roomId);
    if (!current.open) {
      yield* rooms.send(snapshot.roomId, new RecordImport({ room: snapshot }));
    }
    const imported = yield* rooms.state(snapshot.roomId);
    const posted = planned.events.filter(
      (event) => event._tag === "MessagePosted"
    );
    if (
      imported.messages.length !== posted.length ||
      imported.hopCount !== planned.hopCount
    ) {
      return yield* Effect.die("Imported room counts did not match.");
    }
    for (const secret of plan.secrets) {
      yield* copySecret(book, secret, false);
    }
  });

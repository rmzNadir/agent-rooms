import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import type { Actor } from "../domain/actor.ts";
import type { AgentId, RequestId, RoomId } from "../domain/ids.ts";
import { RoomSummary } from "../domain/message.ts";
import {
  decodeAgentId,
  decodeKind,
  type FlagRow,
  type MemberRow,
  notMember,
  persist,
  roomMissing,
  roomQuery,
  schemaRequestId,
} from "./room-sql.ts";

const roomIdPattern = /^room_[0-9a-f]{24}$/;

export const loadFlags = (requestId: RequestId) =>
  Effect.gen(function* () {
    const found = yield* roomQuery(
      requestId,
      "SELECT name, topic, lead_id, hop_count, paused FROM room_flags WHERE id = 1"
    );
    const [row] = found;
    if (row === undefined) {
      return Option.none<FlagRow>();
    }
    const leadId = yield* decodeAgentId(row.lead_id).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "room.flags"))
      )
    );
    return Option.some<FlagRow>({
      hopCount: Number(row.hop_count),
      leadId,
      name: String(row.name),
      paused: Number(row.paused) === 1,
      topic: String(row.topic),
    });
  });

const requireFlags = (requestId: RequestId, hinted: RoomId | undefined) =>
  Effect.gen(function* () {
    const flags = yield* loadFlags(requestId);
    if (Option.isNone(flags)) {
      const fallback = hinted ?? (yield* decodeRoom());
      return yield* roomMissing(fallback, requestId);
    }
    return flags.value;
  });

export const loadMembers = (requestId: RequestId) =>
  Effect.gen(function* () {
    const found = yield* roomQuery(
      requestId,
      `SELECT agent_id, display_name, kind, role, joined, last_read_seq, wake_seq, webhook_url, webhook_secret
       FROM members ORDER BY display_name`
    );
    const members: MemberRow[] = [];
    for (const row of found) {
      const agentId = yield* decodeAgentId(row.agent_id).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(persist(requestId, "room.members"))
        )
      );
      const kind = yield* decodeKind(row.kind).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(persist(requestId, "room.members"))
        )
      );
      const role = row.role === "lead" ? "lead" : "member";
      members.push({
        agentId,
        displayName: String(row.display_name),
        joined: Number(row.joined) === 1,
        kind,
        lastReadSeq: Number(row.last_read_seq),
        role,
        wakeSeq: Number(row.wake_seq ?? 0),
        webhookSecret:
          row.webhook_secret === null ? null : String(row.webhook_secret),
        webhookUrl: row.webhook_url === null ? null : String(row.webhook_url),
      });
    }
    return members;
  });

export const canonicalRoomId = () =>
  Effect.gen(function* () {
    const current = yield* DurableObjectState;
    const { name } = current.id;
    if (name === undefined) {
      return yield* Effect.fail(persist(schemaRequestId, "room.identity"));
    }
    return yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(roomIdPattern)).pipe(
        Schema.brand("RoomId")
      )
    )(name).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(schemaRequestId, "room.identity"))
      )
    );
  });

const decodeRoom = canonicalRoomId;

export const joinedMember = (actor: Actor, members: readonly MemberRow[]) =>
  members.find((member) => member.agentId === actor.agentId && member.joined);

export const loadRoom = (requestId: RequestId) =>
  Effect.gen(function* () {
    const id = yield* canonicalRoomId();
    const flags = yield* loadFlags(requestId);
    if (Option.isNone(flags)) {
      return yield* roomMissing(id, requestId);
    }
    const members = yield* loadMembers(requestId);
    return { flags: flags.value, id, members };
  });

export const requireJoined = (actor: Actor, requestId: RequestId) =>
  Effect.gen(function* () {
    const { flags, id, members } = yield* loadRoom(requestId);
    const member = joinedMember(actor, members);
    if (member === undefined) {
      return yield* notMember(id, requestId);
    }
    return { flags, id, member, members };
  });

export const summary = (requestId: RequestId, actorId: AgentId | null) =>
  Effect.gen(function* () {
    const flags = yield* requireFlags(requestId, undefined);
    const id = yield* canonicalRoomId();
    return new RoomSummary({
      leadId: flags.leadId,
      name: flags.name,
      roomId: id,
      topic: flags.topic,
      youAreLead: actorId !== null && flags.leadId === actorId,
    });
  });

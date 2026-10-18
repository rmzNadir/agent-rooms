import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect } from "effect";
import {
  AgentNotFound,
  InvalidArgument,
  RoomNameTaken,
} from "../domain/errors.ts";
import { RoomSummary } from "../domain/message.ts";
import { findById } from "./directory-agents.ts";
import {
  type DeleteMembershipPayload,
  type DeleteRoomPayload,
  DirectoryAck,
  type ListRoomsPayload,
  type PutMembershipPayload,
  type PutRoomPayload,
  RoomList,
} from "./directory-http-api.ts";
import {
  decodeAgentId,
  decodeRoomId,
  directoryQuery,
  persist,
} from "./directory-sql.ts";

export const putRoom = Effect.fn("DirectoryServer.putRoom")(function* (
  payload: PutRoomPayload
) {
  const current = yield* DurableObjectState;
  const outcome = yield* current.storage
    .transaction(
      Effect.gen(function* () {
        const memberIds = payload.memberIds ?? [];
        for (const agentId of memberIds) {
          const agent = yield* directoryQuery(
            payload.requestId,
            "SELECT id FROM agents WHERE id = ?",
            agentId
          );
          if (agent.length === 0) {
            return { _tag: "MissingAgent" as const, agentId };
          }
        }
        const clash = yield* directoryQuery(
          payload.requestId,
          "SELECT id FROM rooms WHERE name = ? AND id != ?",
          payload.name,
          payload.roomId
        );
        if (clash.length > 0) {
          return { _tag: "Taken" as const };
        }
        yield* directoryQuery(
          payload.requestId,
          `INSERT INTO rooms (id, name, topic, lead_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, topic = excluded.topic, lead_id = excluded.lead_id`,
          payload.roomId,
          payload.name,
          payload.topic,
          payload.leadId
        );
        for (const agentId of memberIds) {
          yield* directoryQuery(
            payload.requestId,
            "INSERT INTO memberships (room_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            payload.roomId,
            agentId
          );
        }
        return { _tag: "Ok" as const };
      })
    )
    .pipe(
      Effect.catchTag("DurableObjectStorageError", () =>
        Effect.fail(persist(payload.requestId, "create_room"))
      )
    );
  if (outcome._tag === "MissingAgent") {
    return yield* new InvalidArgument({
      code: "InvalidArgument",
      details: { constraint: "known agent", field: "members" },
      message: `Agent ${outcome.agentId} was not found. Create the agent before adding them to the room.`,
      operation: "create_room",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  if (outcome._tag === "Taken") {
    return yield* new RoomNameTaken({
      code: "RoomNameTaken",
      details: { name: payload.name },
      message: `A room named ${payload.name} already exists. Choose a different name.`,
      operation: "create_room",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  return new RoomSummary({
    leadId: payload.leadId,
    name: payload.name,
    roomId: payload.roomId,
    topic: payload.topic,
    youAreLead: payload.leadId === payload.actor.agentId,
  });
});

export const deleteRoom = Effect.fn("DirectoryServer.deleteRoom")(function* (
  payload: DeleteRoomPayload
) {
  yield* directoryQuery(
    payload.requestId,
    "DELETE FROM memberships WHERE room_id = ?",
    payload.roomId
  );
  yield* directoryQuery(
    payload.requestId,
    "DELETE FROM rooms WHERE id = ?",
    payload.roomId
  );
  return new DirectoryAck({ ok: true });
});

export const listRooms = Effect.fn("DirectoryServer.listRooms")(function* (
  payload: ListRoomsPayload
) {
  const found = payload.actor.admin
    ? yield* directoryQuery(
        payload.requestId,
        "SELECT * FROM rooms ORDER BY name"
      )
    : yield* directoryQuery(
        payload.requestId,
        `SELECT rooms.* FROM rooms
         JOIN memberships ON memberships.room_id = rooms.id
         WHERE memberships.agent_id = ?
         ORDER BY rooms.name`,
        payload.actor.agentId
      );
  const rooms: RoomSummary[] = [];
  for (const row of found) {
    const roomId = yield* decodeRoomId(row.id).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(payload.requestId, "directory.rooms"))
      )
    );
    const leadId = yield* decodeAgentId(row.lead_id).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(payload.requestId, "directory.rooms"))
      )
    );
    rooms.push(
      new RoomSummary({
        leadId,
        name: String(row.name),
        roomId,
        topic: String(row.topic),
        youAreLead: leadId === payload.actor.agentId,
      })
    );
  }
  return new RoomList({ rooms });
});

export const putMembership = Effect.fn("DirectoryServer.putMembership")(
  function* (payload: PutMembershipPayload) {
    const agent = yield* findById(payload.requestId, payload.agentId);
    if (agent === undefined) {
      return yield* new AgentNotFound({
        code: "AgentNotFound",
        details: { agentId: payload.agentId },
        message: `Agent ${payload.agentId} was not found. Create the agent before inviting them.`,
        operation: "agent.read",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    yield* directoryQuery(
      payload.requestId,
      "INSERT INTO memberships (room_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      payload.roomId,
      payload.agentId
    );
    return new DirectoryAck({ ok: true });
  }
);

export const deleteMembership = Effect.fn("DirectoryServer.deleteMembership")(
  function* (payload: DeleteMembershipPayload) {
    yield* directoryQuery(
      payload.requestId,
      "DELETE FROM memberships WHERE room_id = ? AND agent_id = ?",
      payload.roomId,
      payload.agentId
    );
    return new DirectoryAck({ ok: true });
  }
);

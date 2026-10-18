import { DurableObjectState, type WebSocket } from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { Forbidden, NotInvited } from "../domain/errors.ts";
import { MemberView } from "../domain/message.ts";
import { socketIdsForAgent } from "../domain/sockets.ts";
import {
  Ack,
  type InitRoomPayload,
  type InvitePayload,
  type JoinPayload,
  type LeavePayload,
  MemberList,
  type MembersPayload,
} from "./room-http-api.ts";
import {
  joinedMember,
  loadFlags,
  loadMembers,
  loadRoom,
  requireJoined,
  summary,
} from "./room-members.ts";
import { notMember, persist, roomQuery, SocketSession } from "./room-sql.ts";

export const initRoom = Effect.fn("RoomServer.init")(function* (
  payload: InitRoomPayload
) {
  const existing = yield* loadFlags(payload.requestId);
  if (Option.isSome(existing)) {
    return yield* summary(payload.requestId, payload.leadId);
  }
  const current = yield* DurableObjectState;
  yield* current.storage
    .transaction(
      Effect.gen(function* () {
        yield* roomQuery(
          payload.requestId,
          "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, ?, ?, ?, 0, 0)",
          payload.name,
          payload.topic,
          payload.leadId
        );
        for (const member of payload.members) {
          yield* roomQuery(
            payload.requestId,
            `INSERT INTO members (
            agent_id, display_name, kind, role, joined, last_read_seq, webhook_url, webhook_secret
          ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
            member.agentId,
            member.displayName,
            member.kind,
            member.role,
            member.webhookUrl,
            member.webhookSecret
          );
        }
      })
    )
    .pipe(
      Effect.catchTag("DurableObjectStorageError", () =>
        Effect.fail(persist(payload.requestId, "room.init"))
      )
    );
  return yield* summary(payload.requestId, payload.leadId);
});

export const invite = Effect.fn("RoomServer.invite")(function* (
  payload: InvitePayload
) {
  const { id, members } = yield* loadRoom(payload.requestId);
  const actorJoined = joinedMember(payload.actor, members);
  if (actorJoined === undefined && !payload.actor.admin) {
    return yield* notMember(id, payload.requestId);
  }
  yield* roomQuery(
    payload.requestId,
    `INSERT INTO members (
      agent_id, display_name, kind, role, joined, last_read_seq, webhook_url, webhook_secret
    ) VALUES (?, ?, ?, 'member', 0, 0, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      display_name = excluded.display_name,
      webhook_url = excluded.webhook_url,
      webhook_secret = excluded.webhook_secret`,
    payload.agentId,
    payload.displayName,
    payload.kind,
    payload.webhookUrl,
    payload.webhookSecret
  );
  const updated = yield* loadMembers(payload.requestId);
  const member = updated.find((item) => item.agentId === payload.agentId);
  if (member === undefined) {
    return yield* persist(payload.requestId, "room.invite");
  }
  return new MemberView({
    agentId: member.agentId,
    displayName: member.displayName,
    joined: member.joined,
    kind: member.kind,
    lastReadSeq: member.lastReadSeq,
    role: member.role,
  });
});

export const join = Effect.fn("RoomServer.join")(function* (
  payload: JoinPayload
) {
  const { id, members } = yield* loadRoom(payload.requestId);
  const member = members.find((item) => item.agentId === payload.actor.agentId);
  if (member === undefined) {
    return yield* new NotInvited({
      code: "NotInvited",
      details: { roomId: id },
      message: `You are not invited to room ${id}. Ask a member to invite you.`,
      operation: "join",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  yield* roomQuery(
    payload.requestId,
    "UPDATE members SET joined = 1, webhook_url = ?, webhook_secret = ? WHERE agent_id = ?",
    payload.webhookUrl,
    payload.webhookSecret,
    payload.actor.agentId
  );
  return new MemberView({
    agentId: member.agentId,
    displayName: member.displayName,
    joined: true,
    kind: member.kind,
    lastReadSeq: member.lastReadSeq,
    role: member.role,
  });
});

export const listMembers = Effect.fn("RoomServer.members")(function* (
  payload: MembersPayload
) {
  yield* requireJoined(payload.actor, payload.requestId);
  const members = yield* loadMembers(payload.requestId);
  return new MemberList({
    members: members.map(
      (member) =>
        new MemberView({
          agentId: member.agentId,
          displayName: member.displayName,
          joined: member.joined,
          kind: member.kind,
          lastReadSeq: member.lastReadSeq,
          role: member.role,
        })
    ),
  });
});

export const leave = (sessions: Map<string, WebSocket>) =>
  Effect.fn("RoomServer.leave")(function* (payload: LeavePayload) {
    const { id, members, member } = yield* requireJoined(
      payload.actor,
      payload.requestId
    );
    const remaining = members.filter(
      (item) => item.agentId !== member.agentId && item.joined
    );
    const next =
      member.role === "lead"
        ? (remaining.find((item) => item.kind === "agent") ?? remaining[0])
        : undefined;
    if (member.role === "lead" && next === undefined) {
      return yield* new Forbidden({
        code: "Forbidden",
        details: {},
        message: `You are the only member of room ${id}. Invite someone else before leaving.`,
        operation: "leave",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    const current = yield* DurableObjectState;
    yield* current.storage
      .transaction(
        Effect.gen(function* () {
          if (next !== undefined) {
            yield* roomQuery(
              payload.requestId,
              "UPDATE members SET role = 'member' WHERE agent_id = ?",
              member.agentId
            );
            yield* roomQuery(
              payload.requestId,
              "UPDATE members SET role = 'lead' WHERE agent_id = ?",
              next.agentId
            );
            yield* roomQuery(
              payload.requestId,
              "UPDATE room_flags SET lead_id = ? WHERE id = 1",
              next.agentId
            );
          }
          yield* roomQuery(
            payload.requestId,
            "DELETE FROM members WHERE agent_id = ?",
            member.agentId
          );
        })
      )
      .pipe(
        Effect.catchTag("DurableObjectStorageError", () =>
          Effect.fail(persist(payload.requestId, "leave"))
        )
      );
    const open: Array<{
      id: string;
      agentId: string;
      socket: WebSocket;
    }> = [];
    for (const [socketId, socket] of sessions) {
      const session = yield* socket
        .getAttachment(SocketSession)
        .pipe(
          Effect.catchTag("WebSocketAttachmentError", () =>
            Effect.succeed(undefined)
          )
        );
      if (session !== undefined) {
        open.push({ agentId: session.agentId, id: socketId, socket });
      }
    }
    const closing = new Set(socketIdsForAgent(open, member.agentId));
    for (const item of open) {
      if (!closing.has(item.id)) {
        continue;
      }
      yield* Effect.exit(item.socket.close(1000, "left"));
      sessions.delete(item.id);
    }
    return new Ack({ ok: true });
  });

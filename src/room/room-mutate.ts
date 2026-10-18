import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { MessageNotFound, NotAuthor } from "../domain/errors.ts";
import type { MessageView } from "../domain/message.ts";
import { planPost } from "../domain/wake-policy.ts";
import {
  Ack,
  type EditPayload,
  type ReactPayload,
  type RedactPayload,
  type WebhookPayload,
} from "./room-http-api.ts";
import { requireJoined } from "./room-members.ts";
import { messageBySeq } from "./room-messages.ts";
import { invalid, persist, roomQuery } from "./room-sql.ts";

export const react = <PublishError, PublishEnv>(
  publish: (
    message: MessageView
  ) => Effect.Effect<void, PublishError, PublishEnv>
) =>
  Effect.fn("RoomServer.react")(function* (payload: ReactPayload) {
    const { id, member } = yield* requireJoined(
      payload.actor,
      payload.requestId
    );
    if (
      !/^[\p{L}\p{N}\p{Extended_Pictographic}_+\-:]{1,16}$/u.test(payload.emoji)
    ) {
      return yield* invalid(
        payload.requestId,
        "react",
        "emoji",
        "must be 1 to 16 characters without spaces"
      );
    }
    const existing = yield* messageBySeq(payload.requestId, payload.seq);
    if (Option.isNone(existing)) {
      return yield* new MessageNotFound({
        code: "MessageNotFound",
        details: { roomId: id, seq: payload.seq },
        message: `Message ${payload.seq} was not found in room ${id}.`,
        operation: "message.read",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    const state = yield* DurableObjectState;
    yield* state.storage
      .transaction(
        Effect.gen(function* () {
          const present = yield* roomQuery(
            payload.requestId,
            "SELECT 1 AS present FROM reactions WHERE seq = ? AND agent_id = ? AND emoji = ?",
            payload.seq,
            member.agentId,
            payload.emoji
          );
          if (present.length === 0) {
            yield* roomQuery(
              payload.requestId,
              "INSERT INTO reactions (seq, agent_id, emoji) VALUES (?, ?, ?)",
              payload.seq,
              member.agentId,
              payload.emoji
            );
          } else {
            yield* roomQuery(
              payload.requestId,
              "DELETE FROM reactions WHERE seq = ? AND agent_id = ? AND emoji = ?",
              payload.seq,
              member.agentId,
              payload.emoji
            );
          }
        })
      )
      .pipe(
        Effect.catchTag("DurableObjectStorageError", () =>
          Effect.fail(persist(payload.requestId, "react"))
        )
      );
    const updated = yield* messageBySeq(payload.requestId, payload.seq);
    if (Option.isNone(updated)) {
      return yield* persist(payload.requestId, "react");
    }
    yield* publish(updated.value);
    return updated.value;
  });

export const edit = <PublishError, PublishEnv>(
  publish: (
    message: MessageView
  ) => Effect.Effect<void, PublishError, PublishEnv>
) =>
  Effect.fn("RoomServer.edit")(function* (payload: EditPayload) {
    if (payload.body.trim().length === 0 || payload.body.length > 8000) {
      return yield* invalid(
        payload.requestId,
        "edit_message",
        "body",
        "must be 1 to 8000 characters"
      );
    }
    const { id, flags, members, member } = yield* requireJoined(
      payload.actor,
      payload.requestId
    );
    const existing = yield* messageBySeq(payload.requestId, payload.seq);
    if (Option.isNone(existing)) {
      return yield* new MessageNotFound({
        code: "MessageNotFound",
        details: { roomId: id, seq: payload.seq },
        message: `Message ${payload.seq} was not found in room ${id}.`,
        operation: "message.read",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    if (existing.value.authorId !== member.agentId) {
      return yield* new NotAuthor({
        code: "NotAuthor",
        details: { roomId: id, seq: payload.seq },
        message: `Message ${payload.seq} belongs to someone else. You can edit only your own messages.`,
        operation: "message.mutate",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    const plan = planPost({
      authorId: payload.actor.agentId,
      authorKind: payload.actor.kind,
      body: payload.body,
      explicitMentions: payload.mentions,
      hopCount: flags.hopCount,
      members: members
        .filter((item) => item.joined)
        .map((item) => ({
          agentId: item.agentId,
          displayName: item.displayName,
          kind: item.kind,
        })),
      paused: flags.paused,
    });
    if (plan._tag !== "Accept") {
      return yield* invalid(
        payload.requestId,
        "edit_message",
        "mentions",
        "must still name a real target"
      );
    }
    yield* roomQuery(
      payload.requestId,
      "UPDATE messages SET body = ?, mentions_json = ?, edited_at = ? WHERE seq = ?",
      payload.body,
      JSON.stringify(plan.storedMentions),
      Date.now(),
      payload.seq
    );
    const updated = yield* messageBySeq(payload.requestId, payload.seq);
    if (Option.isNone(updated)) {
      return yield* persist(payload.requestId, "edit_message");
    }
    yield* publish(updated.value);
    return updated.value;
  });

export const redact = <PublishError, PublishEnv>(
  publish: (
    message: MessageView
  ) => Effect.Effect<void, PublishError, PublishEnv>
) =>
  Effect.fn("RoomServer.redact")(function* (payload: RedactPayload) {
    const { id, member } = yield* requireJoined(
      payload.actor,
      payload.requestId
    );
    const existing = yield* messageBySeq(payload.requestId, payload.seq);
    if (Option.isNone(existing)) {
      return yield* new MessageNotFound({
        code: "MessageNotFound",
        details: { roomId: id, seq: payload.seq },
        message: `Message ${payload.seq} was not found in room ${id}.`,
        operation: "message.read",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    if (existing.value.authorId !== member.agentId && !payload.actor.admin) {
      return yield* new NotAuthor({
        code: "NotAuthor",
        details: { roomId: id, seq: payload.seq },
        message: `Message ${payload.seq} belongs to someone else. You can redact only your own messages.`,
        operation: "message.mutate",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    const state = yield* DurableObjectState;
    yield* state.storage
      .transaction(
        Effect.gen(function* () {
          yield* roomQuery(
            payload.requestId,
            "UPDATE messages SET body = '[redacted]', mentions_json = '[]', redacted = 1, edited_at = ? WHERE seq = ?",
            Date.now(),
            payload.seq
          );
          yield* roomQuery(
            payload.requestId,
            "DELETE FROM reactions WHERE seq = ?",
            payload.seq
          );
        })
      )
      .pipe(
        Effect.catchTag("DurableObjectStorageError", () =>
          Effect.fail(persist(payload.requestId, "redact_message"))
        )
      );
    const updated = yield* messageBySeq(payload.requestId, payload.seq);
    if (Option.isNone(updated)) {
      return yield* persist(payload.requestId, "redact_message");
    }
    yield* publish(updated.value);
    return updated.value;
  });

export const setWebhook = Effect.fn("RoomServer.webhook")(function* (
  payload: WebhookPayload
) {
  yield* requireJoined(payload.actor, payload.requestId);
  yield* roomQuery(
    payload.requestId,
    "UPDATE members SET webhook_url = ?, webhook_secret = ? WHERE agent_id = ?",
    payload.webhookUrl,
    payload.webhookSecret,
    payload.actor.agentId
  );
  return new Ack({ ok: true });
});

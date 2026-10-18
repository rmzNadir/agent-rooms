import { type Callback, makeCallback } from "alchemy";
import { DurableObjectState } from "alchemy/Cloudflare";
import { Duration, Effect, Option } from "effect";
import type { AgentId, RequestId } from "../domain/ids.ts";
import type { SqlRow } from "../domain/sql-row.ts";
import { decodeStoredJson, signPayload } from "../domain/token.ts";
import { extendSpan, openSpan, spanFromRow } from "../domain/wake-cursor.ts";
import {
  COOLDOWN_MS,
  classifyWakeStatus,
  deliveryNotBefore,
  MAX_WAKE_ATTEMPTS,
  outboxClaimMs,
  retryDelayMs,
} from "../domain/wake-policy.ts";
import { webhookUrlProblem } from "../domain/webhook-url.ts";
import { canonicalRoomId, loadFlags, loadMembers } from "./room-members.ts";
import {
  decodeStringList,
  decodeWakeJob,
  emptyStored,
  type FlagRow,
  type MemberRow,
  noMessageIds,
  persist,
  roomQuery,
  schemaRequestId,
} from "./room-sql.ts";

export interface WakeHandle {
  callback: Callback<{ readonly agentId: string }> | undefined;
}

export const bindWake = (wake: WakeHandle) =>
  Effect.gen(function* () {
    const scheduleWake = (
      agentId: AgentId,
      delayMs: number,
      requestId: RequestId
    ) =>
      Effect.gen(function* () {
        if (wake.callback === undefined) {
          return yield* persist(requestId, "room.wake");
        }
        yield* wake.callback
          .schedule(agentId, {
            after: Duration.millis(delayMs),
            payload: { agentId },
          })
          .pipe(
            Effect.catchTag("CallbackError", () =>
              Effect.fail(persist(requestId, "room.wake"))
            )
          );
      });

    const traceId = schemaRequestId;
    const dropOutbox = (agentId: AgentId) =>
      roomQuery(traceId, "DELETE FROM wake_outbox WHERE agent_id = ?", agentId);
    const changeCount = () =>
      Effect.gen(function* () {
        const changed = yield* roomQuery(traceId, "SELECT changes() AS n");
        const [row] = changed;
        return Number(row?.n ?? 0);
      });
    const deliver = Effect.fn("RoomServer.deliver")(function* (
      agentId: AgentId
    ) {
      const found = yield* roomQuery(
        traceId,
        "SELECT message_ids_json, since_seq, from_seq, to_seq, delivery_id, not_before, attempts FROM wake_outbox WHERE agent_id = ?",
        agentId
      );
      const [row] = found;
      if (row === undefined) {
        return;
      }
      const now = Date.now();
      const notBefore = Number(row.not_before);
      if (now < notBefore) {
        yield* scheduleWake(agentId, notBefore - now, traceId);
        return;
      }
      const ready = yield* readyMember(agentId);
      if (ready === undefined) {
        return;
      }
      const sent = yield* claimAndSend(agentId, row, ready, now);
      if (sent === undefined) {
        return;
      }
      yield* applyWakeOutcome(sent);
    });
    const readyMember = (agentId: AgentId) =>
      Effect.gen(function* () {
        const members = yield* loadMembers(traceId);
        const member = members.find((item) => item.agentId === agentId);
        const flags = yield* loadFlags(traceId);
        if (member === undefined || Option.isNone(flags)) {
          yield* dropOutbox(agentId);
          return;
        }
        const { webhookSecret, webhookUrl } = member;
        if (
          webhookSecret === null ||
          webhookUrl === null ||
          webhookUrlProblem(webhookUrl) !== undefined
        ) {
          yield* dropOutbox(agentId);
          return;
        }
        return { flags: flags.value, webhookSecret, webhookUrl };
      });
    const claimAndSend = (
      agentId: AgentId,
      row: SqlRow,
      ready: {
        readonly flags: FlagRow;
        readonly webhookSecret: string;
        readonly webhookUrl: string;
      },
      now: number
    ) =>
      Effect.gen(function* () {
        const span = spanFromRow({
          fromSeq: Number(row.from_seq ?? 0),
          sinceSeq: Number(row.since_seq ?? 0),
          toSeq: Number(row.to_seq ?? 0),
        });
        const latestSeq = yield* roomQuery(
          traceId,
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages"
        );
        const [latest] = latestSeq;
        const toSeq =
          span.toSeq > 0 ? span.toSeq : Number(latest?.seq ?? span.fromSeq);
        let deliveryId = String(row.delivery_id ?? "");
        if (deliveryId.length === 0) {
          const bytes = new Uint8Array(8);
          crypto.getRandomValues(bytes);
          deliveryId = `dlv_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
        }
        const current = yield* DurableObjectState;
        const claimed = yield* current.storage.transaction(
          Effect.gen(function* () {
            yield* roomQuery(
              traceId,
              "UPDATE wake_outbox SET not_before = ?, delivery_id = ? WHERE agent_id = ? AND not_before <= ?",
              now + outboxClaimMs,
              deliveryId,
              agentId,
              now
            );
            return yield* changeCount();
          })
        );
        if (claimed !== 1) {
          return;
        }
        const sentIds = String(row.message_ids_json);
        const parsedIds = yield* decodeStoredJson(sentIds).pipe(
          Effect.catchTag("SchemaError", () => Effect.succeed(emptyStored))
        );
        const triggeringMessageIds = yield* decodeStringList(parsedIds).pipe(
          Effect.catchTag("SchemaError", () => Effect.succeed(noMessageIds))
        );
        const roomKey = yield* canonicalRoomId().pipe(
          Effect.catchTag("PersistenceFailed", () =>
            Effect.succeed("unknown" as const)
          )
        );
        const { webhookSecret, webhookUrl } = ready;
        const body = JSON.stringify({
          agentId,
          deliveryId,
          fromSeq: span.fromSeq,
          hopCount: ready.flags.hopCount,
          paused: ready.flags.paused,
          roomId: roomKey,
          roomName: ready.flags.name,
          sinceCursor: span.fromSeq,
          toSeq,
          triggeringMessageIds,
          youAreLead: ready.flags.leadId === agentId,
        });
        const timestamp = String(now);
        const signature = yield* signPayload(webhookSecret, timestamp, body);
        const attempted = yield* Effect.exit(
          Effect.tryPromise({
            catch: () => "transport" as const,
            try: () =>
              fetch(webhookUrl, {
                body,
                headers: {
                  "content-type": "application/json",
                  "x-agent-rooms-signature": `sha256=${signature}`,
                  "x-agent-rooms-timestamp": timestamp,
                },
                method: "POST",
                redirect: "manual",
              }),
          })
        );
        const outcome =
          attempted._tag === "Success"
            ? classifyWakeStatus(attempted.value.status)
            : "failed";
        return {
          agentId,
          attempts: Number(row.attempts),
          current,
          now,
          outcome,
          sentIds,
          toSeq,
        };
      });
    const mutateOutbox = (
      current: Effect.Success<typeof DurableObjectState>,
      sql: string,
      ...bindings: Array<string | number>
    ) =>
      current.storage.transaction(
        Effect.gen(function* () {
          yield* roomQuery(traceId, sql, ...bindings);
          return yield* changeCount();
        })
      );
    const applyWakeOutcome = (sent: {
      readonly agentId: AgentId;
      readonly attempts: number;
      readonly current: Effect.Success<typeof DurableObjectState>;
      readonly now: number;
      readonly outcome: "busy" | "delivered" | "failed";
      readonly sentIds: string;
      readonly toSeq: number;
    }) =>
      Effect.gen(function* () {
        if (sent.outcome === "busy") {
          yield* mutateOutbox(
            sent.current,
            "UPDATE wake_outbox SET not_before = ? WHERE agent_id = ? AND message_ids_json = ?",
            sent.now + COOLDOWN_MS,
            sent.agentId,
            sent.sentIds
          );
          yield* scheduleWake(sent.agentId, COOLDOWN_MS, traceId);
          return;
        }
        if (sent.outcome === "delivered") {
          yield* markDelivered(sent);
          return;
        }
        yield* retryOrDrop(sent);
      });
    const markDelivered = (sent: {
      readonly agentId: AgentId;
      readonly current: Effect.Success<typeof DurableObjectState>;
      readonly now: number;
      readonly sentIds: string;
      readonly toSeq: number;
    }) =>
      Effect.gen(function* () {
        const removed = yield* sent.current.storage.transaction(
          Effect.gen(function* () {
            yield* roomQuery(
              traceId,
              "DELETE FROM wake_outbox WHERE agent_id = ? AND message_ids_json = ?",
              sent.agentId,
              sent.sentIds
            );
            const count = yield* changeCount();
            if (count === 1) {
              yield* roomQuery(
                traceId,
                "UPDATE members SET wake_seq = CASE WHEN wake_seq > ? THEN wake_seq ELSE ? END WHERE agent_id = ?",
                sent.toSeq,
                sent.toSeq,
                sent.agentId
              );
            }
            return count;
          })
        );
        yield* roomQuery(
          traceId,
          `INSERT INTO wake_delivery (agent_id, last_delivered_at) VALUES (?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET last_delivered_at = excluded.last_delivered_at`,
          sent.agentId,
          sent.now
        );
        if (removed !== 1) {
          yield* scheduleWake(sent.agentId, COOLDOWN_MS, traceId);
        }
      });
    const retryOrDrop = (sent: {
      readonly agentId: AgentId;
      readonly attempts: number;
      readonly current: Effect.Success<typeof DurableObjectState>;
      readonly now: number;
      readonly sentIds: string;
    }) =>
      Effect.gen(function* () {
        const nextAttempts = sent.attempts + 1;
        if (nextAttempts >= MAX_WAKE_ATTEMPTS) {
          const removed = yield* mutateOutbox(
            sent.current,
            "DELETE FROM wake_outbox WHERE agent_id = ? AND message_ids_json = ?",
            sent.agentId,
            sent.sentIds
          );
          if (removed !== 1) {
            yield* scheduleWake(sent.agentId, COOLDOWN_MS, traceId);
          }
          return;
        }
        const delay = retryDelayMs(nextAttempts);
        const updated = yield* mutateOutbox(
          sent.current,
          "UPDATE wake_outbox SET attempts = ?, not_before = ? WHERE agent_id = ? AND message_ids_json = ?",
          nextAttempts,
          sent.now + delay,
          sent.agentId,
          sent.sentIds
        );
        yield* scheduleWake(
          sent.agentId,
          updated === 1 ? delay : COOLDOWN_MS,
          traceId
        );
      });

    const registered = yield* makeCallback(
      "deliver-wake",
      Effect.fn("RoomServer.deliverWake")(function* (payload: {
        readonly agentId: string;
      }) {
        const job = yield* decodeWakeJob(payload).pipe(
          Effect.map(Option.some),
          Effect.catchTag("SchemaError", () => Effect.succeed(Option.none()))
        );
        if (Option.isNone(job)) {
          return;
        }
        yield* deliver(job.value.agentId);
      }),
      { retry: { delay: "10 seconds" } }
    );
    wake.callback = registered;

    const enqueue = (
      requestId: RequestId,
      member: MemberRow,
      messageId: string,
      messageSeq: number
    ) =>
      Effect.gen(function* () {
        const existing = yield* roomQuery(
          requestId,
          "SELECT message_ids_json, from_seq, to_seq, delivery_id FROM wake_outbox WHERE agent_id = ?",
          member.agentId
        );
        const [previous] = existing;
        let ids = [messageId];
        if (previous !== undefined) {
          const parsed = yield* decodeStoredJson(
            String(previous.message_ids_json)
          ).pipe(
            Effect.catchTag("SchemaError", () => Effect.succeed(emptyStored))
          );
          const prior = yield* decodeStringList(parsed).pipe(
            Effect.catchTag("SchemaError", () => Effect.succeed(noMessageIds))
          );
          ids = [...prior, messageId];
        }
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        const deliveryId = `dlv_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
        const span =
          previous === undefined
            ? openSpan(member.wakeSeq, messageSeq, deliveryId)
            : extendSpan(
                {
                  deliveryId: String(previous.delivery_id),
                  fromSeq: Number(previous.from_seq),
                  toSeq: Number(previous.to_seq),
                },
                messageSeq,
                deliveryId
              );
        const delivered = yield* roomQuery(
          requestId,
          "SELECT last_delivered_at FROM wake_delivery WHERE agent_id = ?",
          member.agentId
        );
        const last = delivered[0]?.last_delivered_at;
        const notBefore = deliveryNotBefore(
          Date.now(),
          last === undefined || last === null ? undefined : Number(last)
        );
        yield* roomQuery(
          requestId,
          `INSERT INTO wake_outbox (
             agent_id, message_ids_json, since_seq, from_seq, to_seq, delivery_id, not_before, attempts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(agent_id) DO UPDATE SET
             message_ids_json = excluded.message_ids_json,
             since_seq = wake_outbox.from_seq,
             from_seq = wake_outbox.from_seq,
             to_seq = excluded.to_seq,
             delivery_id = excluded.delivery_id,
             not_before = excluded.not_before,
             attempts = wake_outbox.attempts`,
          member.agentId,
          JSON.stringify(ids),
          span.fromSeq,
          span.fromSeq,
          span.toSeq,
          span.deliveryId,
          notBefore
        );
        yield* scheduleWake(
          member.agentId,
          Math.max(0, notBefore - Date.now()),
          requestId
        );
      });
    return { enqueue };
  });

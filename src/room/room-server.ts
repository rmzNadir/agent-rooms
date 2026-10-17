import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as AlchemyHttp from "alchemy/Http"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Actor } from "../domain/actor.ts"
import { MemberKind } from "../domain/actor.ts"
import {
  Forbidden,
  InvalidArgument,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  PersistenceFailed,
  RoomNotFound,
  SelfMentionOnly,
  UnknownMention,
} from "../domain/errors.ts"
import { AgentId, internalRequestId, type RequestId, type RoomId, systemAgentId } from "../domain/ids.ts"
import { MemberView, MessagePage, MessageView, ReactionView, RoomSummary, ThreadSummary, UnreadView } from "../domain/message.ts"
import { renderTranscript } from "../domain/transcript.ts"
import { decodeStoredJson, signPayload } from "../domain/token.ts"
import { socketIdsForAgent } from "../domain/sockets.ts"
import { clampCursor, extendSpan, openSpan, spanFromRow } from "../domain/wake-cursor.ts"
import { webhookUrlProblem } from "../domain/webhook-url.ts"
import {
  COOLDOWN_MS,
  MAX_WAIT_MS,
  MAX_WAKE_ATTEMPTS,
  outboxClaimMs,
  classifyWakeStatus,
  deliveryNotBefore,
  planPost,
  retryDelayMs,
  type WakeMember,
} from "../domain/wake-policy.ts"
import {
  Ack,
  type EditPayload,
  type InitRoomPayload,
  type InvitePayload,
  type JoinPayload,
  type LeavePayload,
  type MarkReadPayload,
  MemberList,
  type MembersPayload,
  type PostPayload,
  type ReactPayload,
  type ReadPayload,
  type RedactPayload,
  RoomHttpApi,
  type SearchPayload,
  ThreadList,
  type ThreadsPayload,
  TranscriptResult,
  type TranscriptPayload,
  type UnreadPayload,
  type WaitPayload,
  type WebhookPayload,
} from "./room-http-api.ts"

const SocketSession = Schema.Struct({ id: Schema.String, agentId: Schema.String })
const WakeJob = Schema.Struct({ agentId: AgentId })
const decodeWakeJob = Schema.decodeUnknownEffect(WakeJob)
const decodeAgentId = Schema.decodeUnknownEffect(AgentId)
const decodeKind = Schema.decodeUnknownEffect(MemberKind)
const decodeStringList = Schema.decodeUnknownEffect(Schema.Array(Schema.String))

const schemaRequestId = internalRequestId
const emptyStored: unknown = []
const noMessageIds: ReadonlyArray<string> = []

const persist = (requestId: RequestId, operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    operation,
    message: "The room could not save that change. Retry the same request.",
    requestId,
    details: {},
    retryable: true,
  })

const invalid = (requestId: RequestId, operation: string, field: string, constraint: string) =>
  new InvalidArgument({
    code: "InvalidArgument",
    operation,
    message: `${field} ${constraint}. Correct it and retry.`,
    requestId,
    details: { field, constraint },
    retryable: false,
  })

const notMember = (roomId: RoomId, requestId: RequestId) =>
  new NotMember({
    code: "NotMember",
    operation: "room.access",
    message: `You are not a member of room ${roomId}. Ask a member to invite you, then join.`,
    requestId,
    details: { roomId },
    retryable: false,
  })

const roomMissing = (roomId: RoomId, requestId: RequestId) =>
  new RoomNotFound({
    code: "RoomNotFound",
    operation: "room.read",
    message: `Room ${roomId} was not found. Check the id from list_rooms and try again.`,
    requestId,
    details: { roomId },
    retryable: false,
  })

type MemberRow = {
  readonly agentId: AgentId
  readonly displayName: string
  readonly kind: "agent" | "human"
  readonly role: "lead" | "member"
  readonly joined: boolean
  readonly lastReadSeq: number
  readonly wakeSeq: number
  readonly webhookUrl: string | null
  readonly webhookSecret: string | null
}

type FlagRow = {
  readonly name: string
  readonly topic: string
  readonly leadId: AgentId
  readonly hopCount: number
  readonly paused: boolean
}

const limitOf = (requestId: RequestId, operation: string, limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return Effect.fail(invalid(requestId, operation, "limit", "must be an integer from 1 to 200"))
  }
  return Effect.succeed(limit)
}

export default class RoomServer extends Cloudflare.DurableObject<RoomServer>()(
  "RoomServer",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const sessions = new Map<string, Cloudflare.WebSocket>()
      const state = yield* Cloudflare.DurableObjectState

      const query = (requestId: RequestId, sql: string, ...bindings: Array<string | number | null>) =>
        Effect.gen(function* () {
          const current = yield* Cloudflare.DurableObjectState
          const cursor = yield* current.storage.sql
            .exec<Record<string, string | number | null>>(sql, ...bindings)
            .pipe(Effect.catchDefect(() => Effect.fail(persist(requestId, "room.sql"))))
          return yield* cursor.toArray().pipe(
            Effect.catchDefect(() => Effect.fail(persist(requestId, "room.sql"))),
          )
        })

      const migrate = Effect.gen(function* () {
        const statements = [
          `CREATE TABLE IF NOT EXISTS room_flags (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            name TEXT NOT NULL,
            topic TEXT NOT NULL,
            lead_id TEXT NOT NULL,
            hop_count INTEGER NOT NULL,
            paused INTEGER NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS members (
            agent_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            role TEXT NOT NULL,
            joined INTEGER NOT NULL,
            last_read_seq INTEGER NOT NULL,
            wake_seq INTEGER NOT NULL DEFAULT 0,
            webhook_url TEXT,
            webhook_secret TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS messages (
            seq INTEGER PRIMARY KEY,
            id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_name TEXT NOT NULL,
            author_kind TEXT NOT NULL,
            body TEXT NOT NULL,
            mentions_json TEXT NOT NULL,
            thread_root INTEGER,
            reply_to INTEGER,
            created_at INTEGER NOT NULL,
            edited_at INTEGER,
            redacted INTEGER NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS reactions (
            seq INTEGER NOT NULL,
            agent_id TEXT NOT NULL,
            emoji TEXT NOT NULL,
            PRIMARY KEY (seq, agent_id, emoji)
          )`,
          `CREATE TABLE IF NOT EXISTS wake_outbox (
            agent_id TEXT PRIMARY KEY,
            message_ids_json TEXT NOT NULL,
            since_seq INTEGER NOT NULL,
            from_seq INTEGER NOT NULL DEFAULT 0,
            to_seq INTEGER NOT NULL DEFAULT 0,
            delivery_id TEXT NOT NULL DEFAULT '',
            not_before INTEGER NOT NULL,
            attempts INTEGER NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS wake_delivery (
            agent_id TEXT PRIMARY KEY,
            last_delivered_at INTEGER
          )`,
        ]
        for (const statement of statements) {
          yield* query(schemaRequestId, statement)
        }
        const columnNames = (table: string) =>
          Effect.map(
            query(schemaRequestId, `PRAGMA table_info(${table})`),
            (rows) => new Set(rows.map((row) => String(row.name))),
          )
        const ensureColumn = (table: string, name: string, definition: string) =>
          Effect.gen(function* () {
            const names = yield* columnNames(table)
            if (!names.has(name)) yield* query(schemaRequestId, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
          })
        yield* ensureColumn("members", "wake_seq", "INTEGER NOT NULL DEFAULT 0")
        yield* ensureColumn("wake_outbox", "from_seq", "INTEGER NOT NULL DEFAULT 0")
        yield* ensureColumn("wake_outbox", "to_seq", "INTEGER NOT NULL DEFAULT 0")
        yield* ensureColumn("wake_outbox", "delivery_id", "TEXT NOT NULL DEFAULT ''")
      }).pipe(Effect.catchTag("PersistenceFailed", (error) => Effect.die(error.message)))

      yield* migrate

      for (const socket of yield* state.getWebSockets()) {
        const session = yield* socket.getAttachment(SocketSession).pipe(
          Effect.catchTag("WebSocketAttachmentError", () => Effect.succeed(undefined)),
        )
        if (session === undefined) {
          yield* Effect.exit(socket.close(1000, "stale"))
          continue
        }
        sessions.set(session.id, socket)
      }

      const broadcast = (text: string) =>
        Effect.gen(function* () {
          for (const socket of sessions.values()) {
            const exit = yield* Effect.exit(socket.send(text))
            if (exit._tag === "Failure") sessions.delete(socket.deserializeAttachment<{ id: string }>()?.id ?? "")
          }
        })

      const loadFlags = (requestId: RequestId) =>
        Effect.gen(function* () {
          const found = yield* query(
            requestId,
            "SELECT name, topic, lead_id, hop_count, paused FROM room_flags WHERE id = 1",
          )
          const row = found[0]
          if (row === undefined) return Option.none<FlagRow>()
          const leadId = yield* decodeAgentId(row.lead_id).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.flags"))),
          )
          return Option.some<FlagRow>({
            name: String(row.name),
            topic: String(row.topic),
            leadId,
            hopCount: Number(row.hop_count),
            paused: Number(row.paused) === 1,
          })
        })

      const requireFlags = (requestId: RequestId, hinted: RoomId | undefined) =>
        Effect.gen(function* () {
          const flags = yield* loadFlags(requestId)
          if (Option.isNone(flags)) {
            const fallback = hinted ?? (yield* decodeRoom())
            return yield* roomMissing(fallback, requestId)
          }
          return flags.value
        })

      const loadMembers = (requestId: RequestId) =>
        Effect.gen(function* () {
          const found = yield* query(
            requestId,
            `SELECT agent_id, display_name, kind, role, joined, last_read_seq, wake_seq, webhook_url, webhook_secret
             FROM members ORDER BY display_name`,
          )
          const members: MemberRow[] = []
          for (const row of found) {
            const agentId = yield* decodeAgentId(row.agent_id).pipe(
              Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.members"))),
            )
            const kind = yield* decodeKind(row.kind).pipe(
              Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.members"))),
            )
            const role = row.role === "lead" ? "lead" : "member"
            members.push({
              agentId,
              displayName: String(row.display_name),
              kind,
              role,
              joined: Number(row.joined) === 1,
              lastReadSeq: Number(row.last_read_seq),
              wakeSeq: Number(row.wake_seq ?? 0),
              webhookUrl: row.webhook_url === null ? null : String(row.webhook_url),
              webhookSecret: row.webhook_secret === null ? null : String(row.webhook_secret),
            })
          }
          return members
        })

      const canonicalRoomId = () =>
        Effect.gen(function* () {
          const current = yield* Cloudflare.DurableObjectState
          const name = current.id.name
          if (name === undefined) {
            return yield* Effect.fail(persist(schemaRequestId, "room.identity"))
          }
          return yield* Schema.decodeUnknownEffect(
            Schema.String.check(Schema.isPattern(/^room_[0-9a-f]{24}$/)).pipe(Schema.brand("RoomId")),
          )(name).pipe(Effect.catchTag("SchemaError", () => Effect.fail(persist(schemaRequestId, "room.identity"))))
        })

      const decodeRoom = canonicalRoomId

      const joinedMember = (actor: Actor, members: ReadonlyArray<MemberRow>) =>
        members.find((member) => member.agentId === actor.agentId && member.joined)

      const requireJoined = (actor: Actor, requestId: RequestId) =>
        Effect.gen(function* () {
          const id = yield* canonicalRoomId()
          const flags = yield* loadFlags(requestId)
          if (Option.isNone(flags)) return yield* roomMissing(id, requestId)
          const members = yield* loadMembers(requestId)
          const member = joinedMember(actor, members)
          if (member === undefined) return yield* notMember(id, requestId)
          return { id, flags: flags.value, members, member }
        })

      const reactionsFor = (requestId: RequestId, seq: number) =>
        Effect.gen(function* () {
          const found = yield* query(
            requestId,
            "SELECT emoji, agent_id FROM reactions WHERE seq = ? ORDER BY emoji",
            seq,
          )
          const reactions: ReactionView[] = []
          for (const row of found) {
            const agentId = yield* decodeAgentId(row.agent_id).pipe(
              Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.reactions"))),
            )
            reactions.push(new ReactionView({ emoji: String(row.emoji), agentId }))
          }
          return reactions
        })

      const toMessage = (requestId: RequestId, row: Record<string, string | number | null>) =>
        Effect.gen(function* () {
          const authorId = yield* decodeAgentId(row.author_id).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.messages"))),
          )
          const authorKind = yield* decodeKind(row.author_kind).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.messages"))),
          )
          const parsed = yield* decodeStoredJson(String(row.mentions_json)).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.messages"))),
          )
          const mentions = yield* decodeStringList(parsed).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "room.messages"))),
          )
          const seq = Number(row.seq)
          const reactions = yield* reactionsFor(requestId, seq)
          return new MessageView({
            seq,
            id: String(row.id),
            authorId,
            authorName: String(row.author_name),
            authorKind,
            body: String(row.body),
            mentions,
            threadRoot: row.thread_root === null ? null : Number(row.thread_root),
            replyTo: row.reply_to === null ? null : Number(row.reply_to),
            createdAt: Number(row.created_at),
            editedAt: row.edited_at === null ? null : Number(row.edited_at),
            redacted: Number(row.redacted) === 1,
            reactions,
          })
        })

      const messageBySeq = (requestId: RequestId, seq: number) =>
        Effect.gen(function* () {
          const found = yield* query(requestId, "SELECT * FROM messages WHERE seq = ?", seq)
          const row = found[0]
          if (row === undefined) return Option.none<MessageView>()
          return Option.some(yield* toMessage(requestId, row))
        })

      const readPage = (requestId: RequestId, since: number, limit: number, thread: number | null) =>
        Effect.gen(function* () {
          const found =
            thread === null
              ? yield* query(
                  requestId,
                  "SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?",
                  since,
                  limit,
                )
              : yield* query(
                  requestId,
                  `SELECT * FROM messages
                   WHERE seq > ? AND (seq = ? OR thread_root = ?)
                   ORDER BY seq ASC LIMIT ?`,
                  since,
                  thread,
                  thread,
                  limit,
                )
          const messages: MessageView[] = []
          for (const row of found) messages.push(yield* toMessage(requestId, row))
          const last = messages[messages.length - 1]
          return new MessagePage({
            messages,
            nextCursor: last === undefined ? null : last.seq,
          })
        })

      const publish = (message: MessageView) =>
        broadcast(JSON.stringify({ type: "message", message }))

      let onDeliver: Alchemy.Callback<{ readonly agentId: string }> | undefined = undefined
      const scheduleWake = (agentId: AgentId, delayMs: number, requestId: RequestId) =>
        Effect.gen(function* () {
          if (onDeliver === undefined) return yield* persist(requestId, "room.wake")
          yield* onDeliver
            .schedule(agentId, {
              after: Duration.millis(delayMs),
              payload: { agentId },
            })
            .pipe(Effect.catchTag("CallbackError", () => Effect.fail(persist(requestId, "room.wake"))))
        })

      const deliver = Effect.fn("RoomServer.deliver")(function* (agentId: AgentId) {
        const requestId = schemaRequestId
        const found = yield* query(
          requestId,
          "SELECT message_ids_json, since_seq, from_seq, to_seq, delivery_id, not_before, attempts FROM wake_outbox WHERE agent_id = ?",
          agentId,
        )
        const row = found[0]
        if (row === undefined) return
        const notBefore = Number(row.not_before)
        const now = Date.now()
        if (now < notBefore) {
          yield* scheduleWake(agentId, notBefore - now, requestId)
          return
        }
        const members = yield* loadMembers(requestId)
        const member = members.find((item) => item.agentId === agentId)
        const flags = yield* loadFlags(requestId)
        if (
          member === undefined ||
          Option.isNone(flags) ||
          member.webhookUrl === null ||
          member.webhookSecret === null
        ) {
          yield* query(requestId, "DELETE FROM wake_outbox WHERE agent_id = ?", agentId)
          return
        }
        const webhookUrl = member.webhookUrl
        const webhookSecret = member.webhookSecret
        if (webhookUrlProblem(webhookUrl) !== undefined) {
          yield* query(requestId, "DELETE FROM wake_outbox WHERE agent_id = ?", agentId)
          return
        }
        const attempts = Number(row.attempts)
        const span = spanFromRow({
          fromSeq: Number(row.from_seq ?? 0),
          toSeq: Number(row.to_seq ?? 0),
          sinceSeq: Number(row.since_seq ?? 0),
        })
        const latestSeq = yield* query(requestId, "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages")
        const toSeq = span.toSeq > 0 ? span.toSeq : Number(latestSeq[0]?.seq ?? span.fromSeq)
        const fromSeq = span.fromSeq
        let deliveryId = String(row.delivery_id ?? "")
        if (deliveryId.length === 0) {
          const bytes = new Uint8Array(8)
          crypto.getRandomValues(bytes)
          deliveryId = `dlv_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`
        }
        const current = yield* Cloudflare.DurableObjectState
        const claimed = yield* current.storage.transaction(
          Effect.gen(function* () {
            yield* query(
              requestId,
              "UPDATE wake_outbox SET not_before = ?, delivery_id = ? WHERE agent_id = ? AND not_before <= ?",
              now + outboxClaimMs,
              deliveryId,
              agentId,
              now,
            )
            const changed = yield* query(requestId, "SELECT changes() AS n")
            return Number(changed[0]?.n ?? 0)
          }),
        )
        if (claimed !== 1) return
        const sentIds = String(row.message_ids_json)
        const mutateOutbox = (sql: string, ...bindings: Array<string | number>) =>
          current.storage.transaction(
            Effect.gen(function* () {
              yield* query(requestId, sql, ...bindings)
              const changed = yield* query(requestId, "SELECT changes() AS n")
              return Number(changed[0]?.n ?? 0)
            }),
          )
        const parsedIds = yield* decodeStoredJson(sentIds).pipe(
          Effect.catchTag("SchemaError", () => Effect.succeed(emptyStored)),
        )
        const triggeringMessageIds = yield* decodeStringList(parsedIds).pipe(
          Effect.catchTag("SchemaError", () => Effect.succeed(noMessageIds)),
        )
        const roomKey = yield* canonicalRoomId().pipe(
          Effect.catchTag("PersistenceFailed", () => Effect.succeed("unknown" as const)),
        )
        const body = JSON.stringify({
          roomId: roomKey,
          roomName: flags.value.name,
          agentId,
          triggeringMessageIds,
          sinceCursor: fromSeq,
          fromSeq,
          toSeq,
          deliveryId,
          hopCount: flags.value.hopCount,
          paused: flags.value.paused,
          youAreLead: flags.value.leadId === agentId,
        })
        const timestamp = String(now)
        const signature = yield* signPayload(webhookSecret, timestamp, body)
        const attempted = yield* Effect.exit(
          Effect.tryPromise({
            try: () =>
              fetch(webhookUrl, {
                method: "POST",
                redirect: "manual",
                headers: {
                  "content-type": "application/json",
                  "x-agent-rooms-timestamp": timestamp,
                  "x-agent-rooms-signature": `sha256=${signature}`,
                },
                body,
              }),
            catch: () => "transport" as const,
          }),
        )
        const outcome = attempted._tag === "Success" ? classifyWakeStatus(attempted.value.status) : "failed"
        if (outcome === "busy") {
          yield* mutateOutbox(
            "UPDATE wake_outbox SET not_before = ? WHERE agent_id = ? AND message_ids_json = ?",
            now + COOLDOWN_MS,
            agentId,
            sentIds,
          )
          yield* scheduleWake(agentId, COOLDOWN_MS, requestId)
          return
        }
        if (outcome === "delivered") {
          const removed = yield* current.storage.transaction(
            Effect.gen(function* () {
              yield* query(
                requestId,
                "DELETE FROM wake_outbox WHERE agent_id = ? AND message_ids_json = ?",
                agentId,
                sentIds,
              )
              const changed = yield* query(requestId, "SELECT changes() AS n")
              const count = Number(changed[0]?.n ?? 0)
              if (count === 1) {
                yield* query(
                  requestId,
                  "UPDATE members SET wake_seq = CASE WHEN wake_seq > ? THEN wake_seq ELSE ? END WHERE agent_id = ?",
                  toSeq,
                  toSeq,
                  agentId,
                )
              }
              return count
            }),
          )
          yield* query(
            requestId,
            `INSERT INTO wake_delivery (agent_id, last_delivered_at) VALUES (?, ?)
             ON CONFLICT(agent_id) DO UPDATE SET last_delivered_at = excluded.last_delivered_at`,
            agentId,
            now,
          )
          if (removed !== 1) yield* scheduleWake(agentId, COOLDOWN_MS, requestId)
          return
        }
        const nextAttempts = attempts + 1
        if (nextAttempts >= MAX_WAKE_ATTEMPTS) {
          const removed = yield* mutateOutbox(
            "DELETE FROM wake_outbox WHERE agent_id = ? AND message_ids_json = ?",
            agentId,
            sentIds,
          )
          if (removed !== 1) yield* scheduleWake(agentId, COOLDOWN_MS, requestId)
          return
        }
        const delay = retryDelayMs(nextAttempts)
        const updated = yield* mutateOutbox(
          "UPDATE wake_outbox SET attempts = ?, not_before = ? WHERE agent_id = ? AND message_ids_json = ?",
          nextAttempts,
          now + delay,
          agentId,
          sentIds,
        )
        if (updated === 1) yield* scheduleWake(agentId, delay, requestId)
        else yield* scheduleWake(agentId, COOLDOWN_MS, requestId)
      })

      const registered = yield* Alchemy.makeCallback(
        "deliver-wake",
        Effect.fn("RoomServer.deliverWake")(function* (payload: { readonly agentId: string }) {
          const job = yield* decodeWakeJob(payload).pipe(
            Effect.map(Option.some),
            Effect.catchTag("SchemaError", () => Effect.succeed(Option.none())),
          )
          if (Option.isNone(job)) return
          yield* deliver(job.value.agentId)
        }),
        { retry: { delay: "10 seconds" } },
      )
      onDeliver = registered

      const enqueue = (requestId: RequestId, member: MemberRow, messageId: string, messageSeq: number) =>
        Effect.gen(function* () {
          const existing = yield* query(
            requestId,
            "SELECT message_ids_json, from_seq, to_seq, delivery_id FROM wake_outbox WHERE agent_id = ?",
            member.agentId,
          )
          const previous = existing[0]
          let ids = [messageId]
          if (previous !== undefined) {
            const parsed = yield* decodeStoredJson(String(previous.message_ids_json)).pipe(
              Effect.catchTag("SchemaError", () => Effect.succeed(emptyStored)),
            )
            const prior = yield* decodeStringList(parsed).pipe(
              Effect.catchTag("SchemaError", () => Effect.succeed(noMessageIds)),
            )
            ids = [...prior, messageId]
          }
          const bytes = new Uint8Array(8)
          crypto.getRandomValues(bytes)
          const deliveryId = `dlv_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`
          const span =
            previous === undefined
              ? openSpan(member.wakeSeq, messageSeq, deliveryId)
              : extendSpan(
                  {
                    fromSeq: Number(previous.from_seq),
                    toSeq: Number(previous.to_seq),
                    deliveryId: String(previous.delivery_id),
                  },
                  messageSeq,
                  deliveryId,
                )
          const delivered = yield* query(
            requestId,
            "SELECT last_delivered_at FROM wake_delivery WHERE agent_id = ?",
            member.agentId,
          )
          const last = delivered[0]?.last_delivered_at
          const notBefore = deliveryNotBefore(Date.now(), last === undefined || last === null ? undefined : Number(last))
          yield* query(
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
            notBefore,
          )
          yield* scheduleWake(member.agentId, Math.max(0, notBefore - Date.now()), requestId)
        })

      const insertMessage = (input: {
        readonly requestId: RequestId
        readonly authorId: AgentId
        readonly authorName: string
        readonly authorKind: "agent" | "human"
        readonly body: string
        readonly mentions: ReadonlyArray<string>
        readonly threadRoot: number | null
        readonly replyTo: number | null
      }) =>
        Effect.gen(function* () {
          const maxRow = yield* query(input.requestId, "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages")
          const seq = Number(maxRow[0]?.seq ?? 0) + 1
          const bytes = new Uint8Array(8)
          crypto.getRandomValues(bytes)
          const id = `msg_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`
          const createdAt = Date.now()
          yield* query(
            input.requestId,
            `INSERT INTO messages (
              seq, id, author_id, author_name, author_kind, body, mentions_json,
              thread_root, reply_to, created_at, edited_at, redacted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
            seq,
            id,
            input.authorId,
            input.authorName,
            input.authorKind,
            input.body,
            JSON.stringify(input.mentions),
            input.threadRoot,
            input.replyTo,
            createdAt,
          )
          return yield* toMessage(input.requestId, {
            seq,
            id,
            author_id: input.authorId,
            author_name: input.authorName,
            author_kind: input.authorKind,
            body: input.body,
            mentions_json: JSON.stringify(input.mentions),
            thread_root: input.threadRoot,
            reply_to: input.replyTo,
            created_at: createdAt,
            edited_at: null,
            redacted: 0,
          })
        })

      const summary = (requestId: RequestId, actorId: AgentId | null) =>
        Effect.gen(function* () {
          const flags = yield* requireFlags(requestId, undefined)
          const id = yield* canonicalRoomId()
          return new RoomSummary({
            roomId: id,
            name: flags.name,
            topic: flags.topic,
            leadId: flags.leadId,
            youAreLead: actorId !== null && flags.leadId === actorId,
          })
        })

      const initRoom = Effect.fn("RoomServer.init")(function* (payload: InitRoomPayload) {
        const existing = yield* loadFlags(payload.requestId)
        if (Option.isSome(existing)) return yield* summary(payload.requestId, payload.leadId)
        const current = yield* Cloudflare.DurableObjectState
        yield* current.storage.transaction(
          Effect.gen(function* () {
            yield* query(
              payload.requestId,
              "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, ?, ?, ?, 0, 0)",
              payload.name,
              payload.topic,
              payload.leadId,
            )
            for (const member of payload.members) {
              yield* query(
                payload.requestId,
                `INSERT INTO members (
                  agent_id, display_name, kind, role, joined, last_read_seq, webhook_url, webhook_secret
                ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
                member.agentId,
                member.displayName,
                member.kind,
                member.role,
                member.webhookUrl,
                member.webhookSecret,
              )
            }
          }),
        ).pipe(
          Effect.catchTag("DurableObjectStorageError", () =>
            Effect.fail(persist(payload.requestId, "room.init")),
          ),
        )
        return yield* summary(payload.requestId, payload.leadId)
      })

      const invite = Effect.fn("RoomServer.invite")(function* (payload: InvitePayload) {
        const id = yield* canonicalRoomId()
        const flags = yield* loadFlags(payload.requestId)
        if (Option.isNone(flags)) return yield* roomMissing(id, payload.requestId)
        const members = yield* loadMembers(payload.requestId)
        const actorJoined = joinedMember(payload.actor, members)
        if (actorJoined === undefined && !payload.actor.admin) return yield* notMember(id, payload.requestId)
        yield* query(
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
          payload.webhookSecret,
        )
        const updated = yield* loadMembers(payload.requestId)
        const member = updated.find((item) => item.agentId === payload.agentId)
        if (member === undefined) return yield* persist(payload.requestId, "room.invite")
        return new MemberView({
          agentId: member.agentId,
          displayName: member.displayName,
          kind: member.kind,
          role: member.role,
          joined: member.joined,
          lastReadSeq: member.lastReadSeq,
        })
      })

      const join = Effect.fn("RoomServer.join")(function* (payload: JoinPayload) {
        const id = yield* canonicalRoomId()
        const flags = yield* loadFlags(payload.requestId)
        if (Option.isNone(flags)) return yield* roomMissing(id, payload.requestId)
        const members = yield* loadMembers(payload.requestId)
        const member = members.find((item) => item.agentId === payload.actor.agentId)
        if (member === undefined) {
          return yield* new NotInvited({
            code: "NotInvited",
            operation: "join",
            message: `You are not invited to room ${id}. Ask a member to invite you.`,
            requestId: payload.requestId,
            details: { roomId: id },
            retryable: false,
          })
        }
        yield* query(
          payload.requestId,
          `UPDATE members SET joined = 1, webhook_url = ?, webhook_secret = ? WHERE agent_id = ?`,
          payload.webhookUrl,
          payload.webhookSecret,
          payload.actor.agentId,
        )
        return new MemberView({
          agentId: member.agentId,
          displayName: member.displayName,
          kind: member.kind,
          role: member.role,
          joined: true,
          lastReadSeq: member.lastReadSeq,
        })
      })

      const leave = Effect.fn("RoomServer.leave")(function* (payload: LeavePayload) {
        const { id, members, member } = yield* requireJoined(payload.actor, payload.requestId)
        const remaining = members.filter((item) => item.agentId !== member.agentId && item.joined)
        const next = member.role === "lead" ? (remaining.find((item) => item.kind === "agent") ?? remaining[0]) : undefined
        if (member.role === "lead" && next === undefined) {
          return yield* new Forbidden({
            code: "Forbidden",
            operation: "leave",
            message: `You are the only member of room ${id}. Invite someone else before leaving.`,
            requestId: payload.requestId,
            details: {},
            retryable: false,
          })
        }
        const current = yield* Cloudflare.DurableObjectState
        yield* current.storage.transaction(
          Effect.gen(function* () {
            if (next !== undefined) {
              yield* query(payload.requestId, "UPDATE members SET role = 'member' WHERE agent_id = ?", member.agentId)
              yield* query(payload.requestId, "UPDATE members SET role = 'lead' WHERE agent_id = ?", next.agentId)
              yield* query(payload.requestId, "UPDATE room_flags SET lead_id = ? WHERE id = 1", next.agentId)
            }
            yield* query(payload.requestId, "DELETE FROM members WHERE agent_id = ?", member.agentId)
          }),
        ).pipe(
          Effect.catchTag("DurableObjectStorageError", () =>
            Effect.fail(persist(payload.requestId, "leave")),
          ),
        )
        const open: Array<{ id: string; agentId: string; socket: Cloudflare.WebSocket }> = []
        for (const [id, socket] of sessions) {
          const session = yield* socket.getAttachment(SocketSession).pipe(
            Effect.catchTag("WebSocketAttachmentError", () => Effect.succeed(undefined)),
          )
          if (session !== undefined) open.push({ id, agentId: session.agentId, socket })
        }
        const closing = new Set(socketIdsForAgent(open, member.agentId))
        for (const item of open) {
          if (!closing.has(item.id)) continue
          yield* Effect.exit(item.socket.close(1000, "left"))
          sessions.delete(item.id)
        }
        return new Ack({ ok: true })
      })

      const listMembers = Effect.fn("RoomServer.members")(function* (payload: MembersPayload) {
        yield* requireJoined(payload.actor, payload.requestId)
        const members = yield* loadMembers(payload.requestId)
        return new MemberList({
          members: members.map(
            (member) =>
              new MemberView({
                agentId: member.agentId,
                displayName: member.displayName,
                kind: member.kind,
                role: member.role,
                joined: member.joined,
                lastReadSeq: member.lastReadSeq,
              }),
          ),
        })
      })

      const postMessage = Effect.fn("RoomServer.postMessage")(function* (payload: PostPayload) {
        if (payload.body.trim().length === 0 || payload.body.length > 8_000) {
          return yield* invalid(payload.requestId, "post_message", "body", "must be 1 to 8000 characters")
        }
        const { id } = yield* requireJoined(payload.actor, payload.requestId)
        let threadRoot = payload.threadRoot
        const replyTo = payload.replyTo
        if (replyTo !== null) {
          const target = yield* messageBySeq(payload.requestId, replyTo)
          if (Option.isNone(target)) {
            return yield* new MessageNotFound({
              code: "MessageNotFound",
              operation: "message.read",
              message: `Message ${replyTo} was not found in room ${id}.`,
              requestId: payload.requestId,
              details: { roomId: id, seq: replyTo },
              retryable: false,
            })
          }
          if (threadRoot === null) threadRoot = target.value.threadRoot ?? target.value.seq
        }
        if (threadRoot !== null) {
          const root = yield* messageBySeq(payload.requestId, threadRoot)
          if (Option.isNone(root)) {
            return yield* new MessageNotFound({
              code: "MessageNotFound",
              operation: "message.read",
              message: `Thread ${threadRoot} was not found in room ${id}.`,
              requestId: payload.requestId,
              details: { roomId: id, seq: threadRoot },
              retryable: false,
            })
          }
        }
        const current = yield* Cloudflare.DurableObjectState
        const stored = yield* current.storage.transaction(
          Effect.gen(function* () {
            const flags = yield* loadFlags(payload.requestId)
            if (Option.isNone(flags)) return { _tag: "Missing" as const }
            const members = yield* loadMembers(payload.requestId)
            const member = joinedMember(payload.actor, members)
            if (member === undefined) return { _tag: "Gone" as const }
            const wakeMembers: WakeMember[] = members
              .filter((item) => item.joined)
              .map((item) => ({ agentId: item.agentId, displayName: item.displayName, kind: item.kind }))
            const plan = planPost({
              authorId: member.agentId,
              authorKind: member.kind,
              body: payload.body,
              explicitMentions: payload.mentions,
              members: wakeMembers,
              hopCount: flags.value.hopCount,
              paused: flags.value.paused,
            })
            if (plan._tag !== "Accept") return { _tag: "Rejected" as const, plan }
            yield* query(
              payload.requestId,
              "UPDATE room_flags SET hop_count = ?, paused = ? WHERE id = 1",
              plan.nextHopCount,
              plan.paused ? 1 : 0,
            )
            const message = yield* insertMessage({
              requestId: payload.requestId,
              authorId: member.agentId,
              authorName: member.displayName,
              authorKind: member.kind,
              body: payload.body,
              mentions: plan.storedMentions,
              threadRoot,
              replyTo,
            })
            let notice: MessageView | undefined
            if (plan.notifyHuman) {
              notice = yield* insertMessage({
                requestId: payload.requestId,
                authorId: systemAgentId,
                authorName: "room",
                authorKind: "agent",
                body: "@human Agent-to-agent wakes are paused after 20 hops with no human message. Post in this room to resume.",
                mentions: ["human"],
                threadRoot: null,
                replyTo: null,
              })
            }
            const endSeq = notice === undefined ? message.seq : notice.seq
            for (const target of plan.targets) {
              const targetMember = members.find((item) => item.agentId === target && item.joined)
              if (targetMember !== undefined) {
                yield* enqueue(payload.requestId, targetMember, message.id, endSeq)
              }
            }
            return { _tag: "Stored" as const, message, notice }
          }),
        ).pipe(
          Effect.catchTag("DurableObjectStorageError", () =>
            Effect.fail(persist(payload.requestId, "post_message")),
          ),
        )
        if (stored._tag === "Missing") return yield* roomMissing(id, payload.requestId)
        if (stored._tag === "Gone") return yield* notMember(id, payload.requestId)
        if (stored._tag === "Rejected") {
          const plan = stored.plan
          if (plan._tag === "RejectUntagged") {
            return yield* new MentionRequired({
              code: "MentionRequired",
              operation: "post_message",
              message: `Message in room ${id} was not posted. Agents must @mention a member, @all, or @human.`,
              requestId: payload.requestId,
              details: { roomId: id },
              retryable: false,
            })
          }
          if (plan._tag === "UnknownMention") {
            return yield* new UnknownMention({
              code: "UnknownMention",
              operation: "post_message",
              message: `@${plan.token} is not a member of room ${id}. Use a display name, @all, or @human.`,
              requestId: payload.requestId,
              details: { roomId: id, token: plan.token },
              retryable: false,
            })
          }
          return yield* new SelfMentionOnly({
            code: "SelfMentionOnly",
            operation: "post_message",
            message: `Message in room ${id} only mentioned you. Mention someone else; posts do not wake their author.`,
            requestId: payload.requestId,
            details: { roomId: id },
            retryable: false,
          })
        }
        yield* publish(stored.message)
        if (stored.notice !== undefined) yield* publish(stored.notice)
        const messages = stored.notice === undefined ? [stored.message] : [stored.message, stored.notice]
        const last = messages[messages.length - 1]
        return new MessagePage({
          messages,
          nextCursor: last === undefined ? null : last.seq,
        })
      })

      const readMessages = Effect.fn("RoomServer.readMessages")(function* (payload: ReadPayload) {
        yield* requireJoined(payload.actor, payload.requestId)
        const limit = yield* limitOf(payload.requestId, "read_messages", payload.limit)
        if (!Number.isInteger(payload.since) || payload.since < 0) {
          return yield* invalid(payload.requestId, "read_messages", "since", "must be a non-negative integer")
        }
        const page = yield* readPage(payload.requestId, payload.since, limit, payload.thread)
        const last = page.messages[page.messages.length - 1]
        if (last !== undefined) yield* advanceReadCursor(payload.requestId, payload.actor.agentId, last.seq, "read_messages")
        return page
      })

      const transcript = Effect.fn("RoomServer.transcript")(function* (payload: TranscriptPayload) {
        const { flags } = yield* requireJoined(payload.actor, payload.requestId)
        const limit = yield* limitOf(payload.requestId, "read_transcript", payload.limit)
        const page = yield* readPage(payload.requestId, payload.since, limit, payload.thread)
        return new TranscriptResult({
          format: payload.format,
          nextCursor: page.nextCursor,
          text: renderTranscript({
            roomName: flags.name,
            format: payload.format,
            messages: page.messages,
          }),
        })
      })

      const threads = Effect.fn("RoomServer.threads")(function* (payload: ThreadsPayload) {
        yield* requireJoined(payload.actor, payload.requestId)
        const limit = yield* limitOf(payload.requestId, "list_threads", payload.limit)
        const found = yield* query(
          payload.requestId,
          `SELECT m.seq AS root, substr(m.body, 1, 180) AS preview,
                  (SELECT COUNT(*) FROM messages r WHERE r.thread_root = m.seq) AS replies,
                  COALESCE((SELECT MAX(seq) FROM messages r WHERE r.thread_root = m.seq), m.seq) AS last_seq
           FROM messages m
           WHERE m.thread_root IS NULL
           ORDER BY last_seq DESC
           LIMIT ?`,
          limit,
        )
        return new ThreadList({
          threads: found.map(
            (row) =>
              new ThreadSummary({
                rootSeq: Number(row.root),
                replies: Number(row.replies),
                lastSeq: Number(row.last_seq),
                preview: String(row.preview),
              }),
          ),
        })
      })

      const search = Effect.fn("RoomServer.search")(function* (payload: SearchPayload) {
        yield* requireJoined(payload.actor, payload.requestId)
        const limit = yield* limitOf(payload.requestId, "search_messages", payload.limit)
        if (payload.query.trim().length === 0) {
          return yield* invalid(payload.requestId, "search_messages", "query", "must not be empty")
        }
        const like = `%${payload.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
        const found = yield* query(
          payload.requestId,
          `SELECT * FROM messages
           WHERE redacted = 0 AND body LIKE ? ESCAPE '\\'
           ORDER BY seq DESC LIMIT ?`,
          like,
          limit,
        )
        const messages: MessageView[] = []
        for (const row of found) messages.push(yield* toMessage(payload.requestId, row))
        messages.reverse()
        const last = messages[messages.length - 1]
        return new MessagePage({ messages, nextCursor: last === undefined ? null : last.seq })
      })

      const wait = Effect.fn("RoomServer.wait")(function* (payload: WaitPayload) {
        yield* requireJoined(payload.actor, payload.requestId)
        if (!Number.isInteger(payload.since) || payload.since < 0) {
          return yield* invalid(payload.requestId, "wait_for_messages", "since", "must be a non-negative integer")
        }
        const limit = yield* limitOf(payload.requestId, "wait_for_messages", payload.limit)
        const timeout = Math.min(Math.max(payload.timeoutMs, 0), MAX_WAIT_MS)
        const deadline = Date.now() + timeout
        while (true) {
          const page = yield* readPage(payload.requestId, payload.since, limit, null)
          if (page.messages.length > 0 || Date.now() >= deadline) return page
          yield* Effect.sleep("400 millis")
        }
      })

      const unread = Effect.fn("RoomServer.unread")(function* (payload: UnreadPayload) {
        const { id, member } = yield* requireJoined(payload.actor, payload.requestId)
        const countRow = yield* query(
          payload.requestId,
          "SELECT COUNT(*) AS n FROM messages WHERE seq > ? AND author_id != ?",
          member.lastReadSeq,
          member.agentId,
        )
        const latest = yield* query(payload.requestId, "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages")
        return new UnreadView({
          roomId: id,
          lastReadSeq: member.lastReadSeq,
          unread: Number(countRow[0]?.n ?? 0),
          latestSeq: Number(latest[0]?.seq ?? 0),
        })
      })

      const advanceReadCursor = (requestId: RequestId, agentId: AgentId, requested: number, operation: string) =>
        Effect.gen(function* () {
          const current = yield* Cloudflare.DurableObjectState
          yield* current.storage.transaction(
            Effect.gen(function* () {
              const latest = yield* query(requestId, "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages")
              const cap = Number(latest[0]?.seq ?? 0)
              const row = yield* query(requestId, "SELECT last_read_seq FROM members WHERE agent_id = ?", agentId)
              const currentRead = Number(row[0]?.last_read_seq ?? 0)
              const next = clampCursor(currentRead, requested, cap)
              yield* query(requestId, "UPDATE members SET last_read_seq = ? WHERE agent_id = ?", next, agentId)
            }),
          ).pipe(
            Effect.catchTag("DurableObjectStorageError", () => Effect.fail(persist(requestId, operation))),
          )
        })

      const markRead = Effect.fn("RoomServer.markRead")(function* (payload: MarkReadPayload) {
        const { member } = yield* requireJoined(payload.actor, payload.requestId)
        if (!Number.isInteger(payload.seq) || payload.seq < 0) {
          return yield* invalid(payload.requestId, "mark_read", "seq", "must be a non-negative integer")
        }
        yield* advanceReadCursor(payload.requestId, member.agentId, payload.seq, "mark_read")
        return yield* unread(payload)
      })

      const react = Effect.fn("RoomServer.react")(function* (payload: ReactPayload) {
        const { id, member } = yield* requireJoined(payload.actor, payload.requestId)
        if (!/^[\p{L}\p{N}\p{Extended_Pictographic}_+\-:]{1,16}$/u.test(payload.emoji)) {
          return yield* invalid(payload.requestId, "react", "emoji", "must be 1 to 16 characters without spaces")
        }
        const existing = yield* messageBySeq(payload.requestId, payload.seq)
        if (Option.isNone(existing)) {
          return yield* new MessageNotFound({
            code: "MessageNotFound",
            operation: "message.read",
            message: `Message ${payload.seq} was not found in room ${id}.`,
            requestId: payload.requestId,
            details: { roomId: id, seq: payload.seq },
            retryable: false,
          })
        }
        const state = yield* Cloudflare.DurableObjectState
        yield* state.storage.transaction(
          Effect.gen(function* () {
            const present = yield* query(
              payload.requestId,
              "SELECT 1 AS present FROM reactions WHERE seq = ? AND agent_id = ? AND emoji = ?",
              payload.seq,
              member.agentId,
              payload.emoji,
            )
            if (present.length === 0) {
              yield* query(
                payload.requestId,
                "INSERT INTO reactions (seq, agent_id, emoji) VALUES (?, ?, ?)",
                payload.seq,
                member.agentId,
                payload.emoji,
              )
            } else {
              yield* query(
                payload.requestId,
                "DELETE FROM reactions WHERE seq = ? AND agent_id = ? AND emoji = ?",
                payload.seq,
                member.agentId,
                payload.emoji,
              )
            }
          }),
        ).pipe(
          Effect.catchTag("DurableObjectStorageError", () =>
            Effect.fail(persist(payload.requestId, "react")),
          ),
        )
        const updated = yield* messageBySeq(payload.requestId, payload.seq)
        if (Option.isNone(updated)) return yield* persist(payload.requestId, "react")
        yield* publish(updated.value)
        return updated.value
      })

      const edit = Effect.fn("RoomServer.edit")(function* (payload: EditPayload) {
        if (payload.body.trim().length === 0 || payload.body.length > 8_000) {
          return yield* invalid(payload.requestId, "edit_message", "body", "must be 1 to 8000 characters")
        }
        const { id, flags, members, member } = yield* requireJoined(payload.actor, payload.requestId)
        const existing = yield* messageBySeq(payload.requestId, payload.seq)
        if (Option.isNone(existing)) {
          return yield* new MessageNotFound({
            code: "MessageNotFound",
            operation: "message.read",
            message: `Message ${payload.seq} was not found in room ${id}.`,
            requestId: payload.requestId,
            details: { roomId: id, seq: payload.seq },
            retryable: false,
          })
        }
        if (existing.value.authorId !== member.agentId) {
          return yield* new NotAuthor({
            code: "NotAuthor",
            operation: "message.mutate",
            message: `Message ${payload.seq} belongs to someone else. You can edit only your own messages.`,
            requestId: payload.requestId,
            details: { roomId: id, seq: payload.seq },
            retryable: false,
          })
        }
        const plan = planPost({
          authorId: payload.actor.agentId,
          authorKind: payload.actor.kind,
          body: payload.body,
          explicitMentions: payload.mentions,
          members: members.filter((item) => item.joined).map((item) => ({
            agentId: item.agentId,
            displayName: item.displayName,
            kind: item.kind,
          })),
          hopCount: flags.hopCount,
          paused: flags.paused,
        })
        if (plan._tag !== "Accept") {
          return yield* invalid(payload.requestId, "edit_message", "mentions", "must still name a real target")
        }
        yield* query(
          payload.requestId,
          "UPDATE messages SET body = ?, mentions_json = ?, edited_at = ? WHERE seq = ?",
          payload.body,
          JSON.stringify(plan.storedMentions),
          Date.now(),
          payload.seq,
        )
        const updated = yield* messageBySeq(payload.requestId, payload.seq)
        if (Option.isNone(updated)) return yield* persist(payload.requestId, "edit_message")
        yield* publish(updated.value)
        return updated.value
      })

      const redact = Effect.fn("RoomServer.redact")(function* (payload: RedactPayload) {
        const { id, member } = yield* requireJoined(payload.actor, payload.requestId)
        const existing = yield* messageBySeq(payload.requestId, payload.seq)
        if (Option.isNone(existing)) {
          return yield* new MessageNotFound({
            code: "MessageNotFound",
            operation: "message.read",
            message: `Message ${payload.seq} was not found in room ${id}.`,
            requestId: payload.requestId,
            details: { roomId: id, seq: payload.seq },
            retryable: false,
          })
        }
        if (existing.value.authorId !== member.agentId && !payload.actor.admin) {
          return yield* new NotAuthor({
            code: "NotAuthor",
            operation: "message.mutate",
            message: `Message ${payload.seq} belongs to someone else. You can redact only your own messages.`,
            requestId: payload.requestId,
            details: { roomId: id, seq: payload.seq },
            retryable: false,
          })
        }
        const state = yield* Cloudflare.DurableObjectState
        yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* query(
              payload.requestId,
              "UPDATE messages SET body = '[redacted]', mentions_json = '[]', redacted = 1, edited_at = ? WHERE seq = ?",
              Date.now(),
              payload.seq,
            )
            yield* query(payload.requestId, "DELETE FROM reactions WHERE seq = ?", payload.seq)
          }),
        ).pipe(
          Effect.catchTag("DurableObjectStorageError", () =>
            Effect.fail(persist(payload.requestId, "redact_message")),
          ),
        )
        const updated = yield* messageBySeq(payload.requestId, payload.seq)
        if (Option.isNone(updated)) return yield* persist(payload.requestId, "redact_message")
        yield* publish(updated.value)
        return updated.value
      })

      const setWebhook = Effect.fn("RoomServer.webhook")(function* (payload: WebhookPayload) {
        yield* requireJoined(payload.actor, payload.requestId)
        yield* query(
          payload.requestId,
          "UPDATE members SET webhook_url = ?, webhook_secret = ? WHERE agent_id = ?",
          payload.webhookUrl,
          payload.webhookSecret,
          payload.actor.agentId,
        )
        return new Ack({ ok: true })
      })

      const handlers = HttpApiBuilder.group(RoomHttpApi, "room", (group) =>
        group
          .handle("init", ({ payload }) => initRoom(payload))
          .handle("invite", ({ payload }) => invite(payload))
          .handle("join", ({ payload }) => join(payload))
          .handle("leave", ({ payload }) => leave(payload))
          .handle("members", ({ payload }) => listMembers(payload))
          .handle("postMessage", ({ payload }) => postMessage(payload))
          .handle("readMessages", ({ payload }) => readMessages(payload))
          .handle("transcript", ({ payload }) => transcript(payload))
          .handle("threads", ({ payload }) => threads(payload))
          .handle("search", ({ payload }) => search(payload))
          .handle("wait", ({ payload }) => wait(payload))
          .handle("unread", ({ payload }) => unread(payload))
          .handle("markRead", ({ payload }) => markRead(payload))
          .handle("react", ({ payload }) => react(payload))
          .handle("edit", ({ payload }) => edit(payload))
          .handle("redact", ({ payload }) => redact(payload))
          .handle("webhook", ({ payload }) => setWebhook(payload)),
      )

      return {
        fetch: Effect.scoped(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const upgrade = request.headers.upgrade
            if (typeof upgrade === "string" && upgrade.toLowerCase() === "websocket") {
              const header = request.headers["x-agent-rooms-agent"]
              if (typeof header !== "string") {
                return HttpServerResponse.text("Sign in before opening the room socket.", { status: 401 })
              }
              const agentId = yield* decodeAgentId(header).pipe(
                Effect.catchTag("SchemaError", () => Effect.succeed("" as const)),
              )
              if (agentId === "") {
                return HttpServerResponse.text("Sign in before opening the room socket.", { status: 401 })
              }
              const members = yield* loadMembers(schemaRequestId).pipe(
                Effect.catchTag("PersistenceFailed", () => Effect.succeed([] as MemberRow[])),
              )
              const member = members.find((item) => item.agentId === agentId && item.joined)
              if (member === undefined) {
                return HttpServerResponse.text("Join the room before opening the socket.", { status: 403 })
              }
              const [response, socket] = yield* Cloudflare.upgrade()
              const id = crypto.randomUUID()
              yield* socket.setAttachment(SocketSession, { id, agentId })
              sessions.set(id, socket)
              return response
            }
            const handle = yield* HttpRouter.toHttpEffect(
              HttpApiBuilder.layer(RoomHttpApi).pipe(
                Layer.provide(handlers),
                Layer.provide(AlchemyHttp.Platform),
              ),
            )
            return yield* handle
          }),
        ),
        webSocketMessage: Effect.fn("RoomServer.webSocketMessage")(function* (
          _socket: Cloudflare.WebSocket,
          _message: string | ArrayBuffer,
        ) {
          return undefined
        }),
        webSocketClose: Effect.fn("RoomServer.webSocketClose")(function* (socket: Cloudflare.WebSocket) {
          const session = yield* socket.getAttachment(SocketSession).pipe(
            Effect.catchTag("WebSocketAttachmentError", () => Effect.succeed(undefined)),
          )
          if (session !== undefined) sessions.delete(session.id)
        }),
        webSocketError: Effect.fn("RoomServer.webSocketError")(function* (socket: Cloudflare.WebSocket) {
          const session = yield* socket.getAttachment(SocketSession).pipe(
            Effect.catchTag("WebSocketAttachmentError", () => Effect.succeed(undefined)),
          )
          if (session !== undefined) sessions.delete(session.id)
        }),
      }
    })
  }),
) {}

import { Effect, Schema } from "effect";
import { MemberKind } from "../domain/actor.ts";
import {
  InvalidArgument,
  NotMember,
  PersistenceFailed,
  RoomNotFound,
} from "../domain/errors.ts";
import {
  AgentId,
  internalRequestId,
  type RequestId,
  type RoomId,
} from "../domain/ids.ts";
import { execRows } from "../domain/sql-exec.ts";

export const SocketSession = Schema.Struct({
  agentId: Schema.String,
  id: Schema.String,
});
const WakeJob = Schema.Struct({ agentId: AgentId });
export const decodeWakeJob = Schema.decodeUnknownEffect(WakeJob);
export const decodeAgentId = Schema.decodeUnknownEffect(AgentId);
export const decodeKind = Schema.decodeUnknownEffect(MemberKind);
export const decodeStringList = Schema.decodeUnknownEffect(
  Schema.Array(Schema.String)
);

export const schemaRequestId = internalRequestId;
export const emptyStored: readonly string[] = [];
export const noMessageIds: readonly string[] = [];

export const persist = (requestId: RequestId, operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    details: {},
    message: "The room could not save that change. Retry the same request.",
    operation,
    requestId,
    retryable: true,
  });

export const invalid = (
  requestId: RequestId,
  operation: string,
  field: string,
  constraint: string
) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint, field },
    message: `${field} ${constraint}. Correct it and retry.`,
    operation,
    requestId,
    retryable: false,
  });

export const notMember = (roomId: RoomId, requestId: RequestId) =>
  new NotMember({
    code: "NotMember",
    details: { roomId },
    message: `You are not a member of room ${roomId}. Ask a member to invite you, then join.`,
    operation: "room.access",
    requestId,
    retryable: false,
  });

export const roomMissing = (roomId: RoomId, requestId: RequestId) =>
  new RoomNotFound({
    code: "RoomNotFound",
    details: { roomId },
    message: `Room ${roomId} was not found. Check the id from list_rooms and try again.`,
    operation: "room.read",
    requestId,
    retryable: false,
  });

export interface MemberRow {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly joined: boolean;
  readonly kind: "agent" | "human";
  readonly lastReadSeq: number;
  readonly role: "lead" | "member";
  readonly wakeSeq: number;
  readonly webhookSecret: string | null;
  readonly webhookUrl: string | null;
}

export interface FlagRow {
  readonly hopCount: number;
  readonly leadId: AgentId;
  readonly name: string;
  readonly paused: boolean;
  readonly topic: string;
}

export const limitOf = (
  requestId: RequestId,
  operation: string,
  limit: number
) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return Effect.fail(
      invalid(requestId, operation, "limit", "must be an integer from 1 to 200")
    );
  }
  return Effect.succeed(limit);
};
export const roomQuery = (
  requestId: RequestId,
  sql: string,
  ...bindings: Array<string | number | null>
) => execRows(sql, bindings, persist(requestId, "room.sql"));
export const migrateRoom = Effect.gen(function* () {
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
  ];
  for (const statement of statements) {
    yield* roomQuery(schemaRequestId, statement);
  }
  const columnNames = (table: string) =>
    Effect.map(
      roomQuery(schemaRequestId, `PRAGMA table_info(${table})`),
      (rows) => new Set(rows.map((row) => String(row.name)))
    );
  const ensureColumn = (table: string, name: string, definition: string) =>
    Effect.gen(function* () {
      const names = yield* columnNames(table);
      if (!names.has(name)) {
        yield* roomQuery(
          schemaRequestId,
          `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`
        );
      }
    });
  yield* ensureColumn("members", "wake_seq", "INTEGER NOT NULL DEFAULT 0");
  yield* ensureColumn("wake_outbox", "from_seq", "INTEGER NOT NULL DEFAULT 0");
  yield* ensureColumn("wake_outbox", "to_seq", "INTEGER NOT NULL DEFAULT 0");
  yield* ensureColumn("wake_outbox", "delivery_id", "TEXT NOT NULL DEFAULT ''");
}).pipe(
  Effect.catchTag("PersistenceFailed", (error) => Effect.die(error.message))
);

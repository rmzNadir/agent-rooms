import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import type { AgentId, RequestId } from "../domain/ids.ts";
import { MessagePage, MessageView, ReactionView } from "../domain/message.ts";
import type { SqlRow } from "../domain/sql-row.ts";
import { decodeStoredJson } from "../domain/token.ts";
import { clampCursor } from "../domain/wake-cursor.ts";
import {
  decodeAgentId,
  decodeKind,
  decodeStringList,
  persist,
  roomQuery,
} from "./room-sql.ts";

export const reactionsFor = (requestId: RequestId, seq: number) =>
  Effect.gen(function* () {
    const found = yield* roomQuery(
      requestId,
      "SELECT emoji, agent_id FROM reactions WHERE seq = ? ORDER BY emoji",
      seq
    );
    const reactions: ReactionView[] = [];
    for (const row of found) {
      const agentId = yield* decodeAgentId(row.agent_id).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(persist(requestId, "room.reactions"))
        )
      );
      reactions.push(new ReactionView({ agentId, emoji: String(row.emoji) }));
    }
    return reactions;
  });

export const toMessage = (
  requestId: RequestId,
  row: Pick<
    SqlRow,
    | "author_id"
    | "author_kind"
    | "author_name"
    | "body"
    | "created_at"
    | "edited_at"
    | "id"
    | "mentions_json"
    | "redacted"
    | "reply_to"
    | "seq"
    | "thread_root"
  >
) =>
  Effect.gen(function* () {
    const authorId = yield* decodeAgentId(row.author_id).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "room.messages"))
      )
    );
    const authorKind = yield* decodeKind(row.author_kind).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "room.messages"))
      )
    );
    const parsed = yield* decodeStoredJson(String(row.mentions_json)).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "room.messages"))
      )
    );
    const mentions = yield* decodeStringList(parsed).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "room.messages"))
      )
    );
    const seq = Number(row.seq);
    const reactions = yield* reactionsFor(requestId, seq);
    return new MessageView({
      authorId,
      authorKind,
      authorName: String(row.author_name),
      body: String(row.body),
      createdAt: Number(row.created_at),
      editedAt: row.edited_at === null ? null : Number(row.edited_at),
      id: String(row.id),
      mentions,
      reactions,
      redacted: Number(row.redacted) === 1,
      replyTo: row.reply_to === null ? null : Number(row.reply_to),
      seq,
      threadRoot: row.thread_root === null ? null : Number(row.thread_root),
    });
  });

export const messageBySeq = (requestId: RequestId, seq: number) =>
  Effect.gen(function* () {
    const found = yield* roomQuery(
      requestId,
      "SELECT * FROM messages WHERE seq = ?",
      seq
    );
    const [row] = found;
    if (row === undefined) {
      return Option.none<MessageView>();
    }
    return Option.some(yield* toMessage(requestId, row));
  });

export const readPage = (
  requestId: RequestId,
  since: number,
  limit: number,
  thread: number | null
) =>
  Effect.gen(function* () {
    const found =
      thread === null
        ? yield* roomQuery(
            requestId,
            "SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?",
            since,
            limit
          )
        : yield* roomQuery(
            requestId,
            `SELECT * FROM messages
             WHERE seq > ? AND (seq = ? OR thread_root = ?)
             ORDER BY seq ASC LIMIT ?`,
            since,
            thread,
            thread,
            limit
          );
    const messages: MessageView[] = [];
    for (const row of found) {
      messages.push(yield* toMessage(requestId, row));
    }
    const last = messages.at(-1);
    return new MessagePage({
      messages,
      nextCursor: last === undefined ? null : last.seq,
    });
  });

export const insertMessage = (input: {
  readonly requestId: RequestId;
  readonly authorId: AgentId;
  readonly authorName: string;
  readonly authorKind: "agent" | "human";
  readonly body: string;
  readonly mentions: readonly string[];
  readonly threadRoot: number | null;
  readonly replyTo: number | null;
}) =>
  Effect.gen(function* () {
    const maxRow = yield* roomQuery(
      input.requestId,
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages"
    );
    const seq = Number(maxRow[0]?.seq ?? 0) + 1;
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = `msg_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    const createdAt = Date.now();
    yield* roomQuery(
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
      createdAt
    );
    return yield* toMessage(input.requestId, {
      author_id: input.authorId,
      author_kind: input.authorKind,
      author_name: input.authorName,
      body: input.body,
      created_at: createdAt,
      edited_at: null,
      id,
      mentions_json: JSON.stringify(input.mentions),
      redacted: 0,
      reply_to: input.replyTo,
      seq,
      thread_root: input.threadRoot,
    });
  });

export const advanceReadCursor = (
  requestId: RequestId,
  agentId: AgentId,
  requested: number,
  operation: string
) =>
  Effect.gen(function* () {
    const current = yield* DurableObjectState;
    yield* current.storage
      .transaction(
        Effect.gen(function* () {
          const latest = yield* roomQuery(
            requestId,
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages"
          );
          const cap = Number(latest[0]?.seq ?? 0);
          const row = yield* roomQuery(
            requestId,
            "SELECT last_read_seq FROM members WHERE agent_id = ?",
            agentId
          );
          const currentRead = Number(row[0]?.last_read_seq ?? 0);
          const next = clampCursor(currentRead, requested, cap);
          yield* roomQuery(
            requestId,
            "UPDATE members SET last_read_seq = ? WHERE agent_id = ?",
            next,
            agentId
          );
        })
      )
      .pipe(
        Effect.catchTag("DurableObjectStorageError", () =>
          Effect.fail(persist(requestId, operation))
        )
      );
  });

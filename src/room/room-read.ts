import { Effect } from "effect";
import {
  MessagePage,
  type MessageView,
  ThreadSummary,
  UnreadView,
} from "../domain/message.ts";
import { renderTranscript } from "../domain/transcript.ts";
import { MAX_WAIT_MS } from "../domain/wake-policy.ts";
import {
  type MarkReadPayload,
  type ReadPayload,
  type SearchPayload,
  ThreadList,
  type ThreadsPayload,
  type TranscriptPayload,
  TranscriptResult,
  type UnreadPayload,
  type WaitPayload,
} from "./room-http-api.ts";
import { requireJoined } from "./room-members.ts";
import { advanceReadCursor, readPage, toMessage } from "./room-messages.ts";
import { invalid, limitOf, roomQuery } from "./room-sql.ts";

export const readMessages = Effect.fn("RoomServer.readMessages")(function* (
  payload: ReadPayload
) {
  yield* requireJoined(payload.actor, payload.requestId);
  const limit = yield* limitOf(
    payload.requestId,
    "read_messages",
    payload.limit
  );
  if (!Number.isInteger(payload.since) || payload.since < 0) {
    return yield* invalid(
      payload.requestId,
      "read_messages",
      "since",
      "must be a non-negative integer"
    );
  }
  const page = yield* readPage(
    payload.requestId,
    payload.since,
    limit,
    payload.thread
  );
  const last = page.messages.at(-1);
  if (last !== undefined) {
    yield* advanceReadCursor(
      payload.requestId,
      payload.actor.agentId,
      last.seq,
      "read_messages"
    );
  }
  return page;
});

export const transcript = Effect.fn("RoomServer.transcript")(function* (
  payload: TranscriptPayload
) {
  const { flags } = yield* requireJoined(payload.actor, payload.requestId);
  const limit = yield* limitOf(
    payload.requestId,
    "read_transcript",
    payload.limit
  );
  const page = yield* readPage(
    payload.requestId,
    payload.since,
    limit,
    payload.thread
  );
  return new TranscriptResult({
    format: payload.format,
    nextCursor: page.nextCursor,
    text: renderTranscript({
      format: payload.format,
      messages: page.messages,
      roomName: flags.name,
    }),
  });
});

export const threads = Effect.fn("RoomServer.threads")(function* (
  payload: ThreadsPayload
) {
  yield* requireJoined(payload.actor, payload.requestId);
  const limit = yield* limitOf(
    payload.requestId,
    "list_threads",
    payload.limit
  );
  const found = yield* roomQuery(
    payload.requestId,
    `SELECT m.seq AS root, substr(m.body, 1, 180) AS preview,
            (SELECT COUNT(*) FROM messages r WHERE r.thread_root = m.seq) AS replies,
            COALESCE((SELECT MAX(seq) FROM messages r WHERE r.thread_root = m.seq), m.seq) AS last_seq
     FROM messages m
     WHERE m.thread_root IS NULL
     ORDER BY last_seq DESC
     LIMIT ?`,
    limit
  );
  return new ThreadList({
    threads: found.map(
      (row) =>
        new ThreadSummary({
          lastSeq: Number(row.last_seq),
          preview: String(row.preview),
          replies: Number(row.replies),
          rootSeq: Number(row.root),
        })
    ),
  });
});

export const search = Effect.fn("RoomServer.search")(function* (
  payload: SearchPayload
) {
  yield* requireJoined(payload.actor, payload.requestId);
  const limit = yield* limitOf(
    payload.requestId,
    "search_messages",
    payload.limit
  );
  if (payload.query.trim().length === 0) {
    return yield* invalid(
      payload.requestId,
      "search_messages",
      "query",
      "must not be empty"
    );
  }
  const like = `%${payload.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const found = yield* roomQuery(
    payload.requestId,
    `SELECT * FROM messages
     WHERE redacted = 0 AND body LIKE ? ESCAPE '\\'
     ORDER BY seq DESC LIMIT ?`,
    like,
    limit
  );
  const messages: MessageView[] = [];
  for (const row of found) {
    messages.push(yield* toMessage(payload.requestId, row));
  }
  messages.reverse();
  const last = messages.at(-1);
  return new MessagePage({
    messages,
    nextCursor: last === undefined ? null : last.seq,
  });
});

type PageRead = ReturnType<typeof readPage>;

const pollUntil = (
  requestId: WaitPayload["requestId"],
  since: number,
  limit: number,
  deadline: number
): Effect.Effect<
  Effect.Success<PageRead>,
  Effect.Error<PageRead>,
  Effect.Services<PageRead>
> =>
  Effect.gen(function* () {
    const page = yield* readPage(requestId, since, limit, null);
    if (page.messages.length > 0 || Date.now() >= deadline) {
      return page;
    }
    yield* Effect.sleep("400 millis");
    return yield* pollUntil(requestId, since, limit, deadline);
  });

export const wait = Effect.fn("RoomServer.wait")(function* (
  payload: WaitPayload
) {
  yield* requireJoined(payload.actor, payload.requestId);
  if (!Number.isInteger(payload.since) || payload.since < 0) {
    return yield* invalid(
      payload.requestId,
      "wait_for_messages",
      "since",
      "must be a non-negative integer"
    );
  }
  const limit = yield* limitOf(
    payload.requestId,
    "wait_for_messages",
    payload.limit
  );
  const timeout = Math.min(Math.max(payload.timeoutMs, 0), MAX_WAIT_MS);
  return yield* pollUntil(
    payload.requestId,
    payload.since,
    limit,
    Date.now() + timeout
  );
});

export const unread = Effect.fn("RoomServer.unread")(function* (
  payload: UnreadPayload
) {
  const { id, member } = yield* requireJoined(payload.actor, payload.requestId);
  const countRow = yield* roomQuery(
    payload.requestId,
    "SELECT COUNT(*) AS n FROM messages WHERE seq > ? AND author_id != ?",
    member.lastReadSeq,
    member.agentId
  );
  const latest = yield* roomQuery(
    payload.requestId,
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages"
  );
  return new UnreadView({
    lastReadSeq: member.lastReadSeq,
    latestSeq: Number(latest[0]?.seq ?? 0),
    roomId: id,
    unread: Number(countRow[0]?.n ?? 0),
  });
});

export const markRead = Effect.fn("RoomServer.markRead")(function* (
  payload: MarkReadPayload
) {
  const { member } = yield* requireJoined(payload.actor, payload.requestId);
  if (!Number.isInteger(payload.seq) || payload.seq < 0) {
    return yield* invalid(
      payload.requestId,
      "mark_read",
      "seq",
      "must be a non-negative integer"
    );
  }
  yield* advanceReadCursor(
    payload.requestId,
    member.agentId,
    payload.seq,
    "mark_read"
  );
  return yield* unread(payload);
});

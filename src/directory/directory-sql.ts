import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { DisplayName } from "../domain/actor.ts";
import {
  Forbidden,
  InvalidArgument,
  PersistenceFailed,
} from "../domain/errors.ts";
import { AgentId, type RequestId, RoomId } from "../domain/ids.ts";
import { execRows } from "../domain/sql-exec.ts";
import { webhookUrlProblem } from "../domain/webhook-url.ts";

export const decodeAgentId = Schema.decodeUnknownEffect(AgentId);
export const decodeRoomId = Schema.decodeUnknownEffect(RoomId);
export const decodeName = Schema.decodeUnknownEffect(DisplayName);
export const decodeKind = Schema.decodeUnknownEffect(
  Schema.Literals(["agent", "human"])
);

export const persist = (requestId: RequestId, operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    details: {},
    message:
      "The directory could not save that change. Retry the same request.",
    operation,
    requestId,
    retryable: true,
  });

export const forbidden = (requestId: RequestId, operation: string) =>
  new Forbidden({
    code: "Forbidden",
    details: {},
    message:
      "That action is limited to the admin human. Use an admin token and retry.",
    operation,
    requestId,
    retryable: false,
  });

export const requireWebhook = (
  requestId: RequestId,
  operation: string,
  webhookUrl: string | null
) => {
  if (webhookUrl === null) {
    return Effect.void;
  }
  const problem = webhookUrlProblem(webhookUrl);
  if (problem === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    new InvalidArgument({
      code: "InvalidArgument",
      details: { constraint: problem, field: "webhookUrl" },
      message: `Webhook URL ${problem}. Use https, or http://127.0.0.1 for a local listener.`,
      operation,
      requestId,
      retryable: false,
    })
  );
};
export const directoryQuery = (
  requestId: RequestId,
  sql: string,
  ...bindings: Array<string | number | null>
) => execRows(sql, bindings, persist(requestId, "directory.sql"));
export const migrateDirectory = Effect.gen(function* () {
  const statements = [
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      admin INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      webhook_url TEXT,
      webhook_secret TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      lead_id TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS memberships (
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (room_id, agent_id)
    )`,
  ];
  for (const statement of statements) {
    const current = yield* DurableObjectState;
    yield* current.storage.sql
      .exec(statement)
      .pipe(Effect.catchDefect(() => Effect.die("directory schema failed")));
  }
});

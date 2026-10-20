import { Effect, Schema } from "effect";
import { execRows } from "../domain/sql-exec.ts";
import type { SqlCell, SqlRow } from "../domain/sql-row.ts";
import { decodeStoredJson } from "../domain/token.ts";
import {
  type LegacyDirectory,
  LegacyDirectorySchema,
  LegacyRoomSchema,
} from "../model/migrate.ts";
import type { StoredCredential } from "./credentials.ts";

const query = (sql: string, ...bindings: Array<string | number | null>) =>
  execRows(sql, bindings, "legacy").pipe(
    Effect.catch((reason) =>
      Effect.die(`The legacy tables could not be read. ${String(reason)}`)
    )
  );

export const cellText = (value: SqlCell) =>
  value === undefined || value === null ? "" : String(value);

export const cellNumber = (value: SqlCell) =>
  value === undefined || value === null ? 0 : Number(String(value));

export const optionalNumber = (value: SqlCell) =>
  value === undefined || value === null || value === "" ? null : Number(value);

const kindOf = (value: SqlCell) =>
  cellText(value) === "human" ? "human" : "agent";

const tablePresent = (name: string) =>
  Effect.map(
    query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      name
    ),
    (rows) => rows.length > 0
  );

const whenPresent = (name: string) =>
  tablePresent(name).pipe(
    Effect.flatMap((present) =>
      present ? query(`SELECT * FROM ${name}`) : Effect.succeed([] as SqlRow[])
    )
  );

export const alreadyMigrated = Effect.gen(function* () {
  if (!(yield* tablePresent("domain_migrated"))) {
    return false;
  }
  const rows = yield* query(
    "SELECT done AS n FROM domain_migrated WHERE id = 1"
  );
  return cellNumber(rows[0]?.n) === 1;
});

export const markMigrated = Effect.gen(function* () {
  yield* query(
    `CREATE TABLE IF NOT EXISTS domain_migrated (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      done INTEGER NOT NULL
    )`
  );
  yield* query(
    "INSERT INTO domain_migrated (id, done) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET done = 1"
  );
});

const mentionList = (value: SqlCell) =>
  Effect.gen(function* () {
    const source = cellText(value);
    if (source.length === 0) {
      return [] as readonly string[];
    }
    const parsed = yield* decodeStoredJson(source).pipe(
      Effect.catchTag("SchemaError", () => Effect.die("mentions"))
    );
    return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      parsed
    ).pipe(Effect.catchTag("SchemaError", () => Effect.die("mentions")));
  });

const memberOf = (member: SqlRow) => ({
  agentId: cellText(member.agent_id),
  displayName: cellText(member.display_name),
  joined: cellNumber(member.joined) === 1,
  kind: kindOf(member.kind),
  lastReadSeq: cellNumber(member.last_read_seq),
  role:
    cellText(member.role) === "lead" ? ("lead" as const) : ("member" as const),
  webhookSecret: cellText(member.webhook_secret),
  webhookUrl: cellText(member.webhook_url),
});

const messageOf = (message: SqlRow, reactions: readonly SqlRow[]) =>
  Effect.gen(function* () {
    return {
      authorId: cellText(message.author_id),
      authorKind: kindOf(message.author_kind),
      authorName: cellText(message.author_name),
      body: cellText(message.body),
      createdAt: cellNumber(message.created_at),
      mentions: yield* mentionList(message.mentions_json),
      reactions: reactions
        .filter(
          (reaction) => cellNumber(reaction.seq) === cellNumber(message.seq)
        )
        .map((reaction) => ({
          agentId: cellText(reaction.agent_id),
          emoji: cellText(reaction.emoji),
        })),
      redacted: cellNumber(message.redacted) === 1,
      replyTo: optionalNumber(message.reply_to),
      seq: cellNumber(message.seq),
      threadRoot: optionalNumber(message.thread_root),
    };
  });

export const readDirectoryTables = Effect.gen(function* () {
  if (!(yield* tablePresent("agents"))) {
    return;
  }
  const agents = yield* query("SELECT * FROM agents");
  const rooms = yield* whenPresent("rooms");
  const memberships = yield* whenPresent("memberships");
  const snapshot: LegacyDirectory = {
    agents: agents.map((agent) => ({
      admin: cellNumber(agent.admin) === 1,
      agentId: cellText(agent.id),
      displayName: cellText(agent.display_name),
      kind: kindOf(agent.kind),
      tokenHash: cellText(agent.token_hash),
      webhookSecret: cellText(agent.webhook_secret),
      webhookUrl: cellText(agent.webhook_url),
    })),
    rooms: rooms.map((room) => ({
      hopCount: 0,
      leadId: cellText(room.lead_id),
      members: memberships.flatMap((membership) => {
        if (cellText(membership.room_id) !== cellText(room.id)) {
          return [];
        }
        const agent = agents.find(
          (item) => cellText(item.id) === cellText(membership.agent_id)
        );
        if (agent === undefined) {
          return [];
        }
        return [
          {
            agentId: cellText(agent.id),
            displayName: cellText(agent.display_name),
            joined: true,
            kind: kindOf(agent.kind),
            lastReadSeq: 0,
            role:
              cellText(agent.id) === cellText(room.lead_id)
                ? ("lead" as const)
                : ("member" as const),
            webhookSecret: cellText(agent.webhook_secret),
            webhookUrl: cellText(agent.webhook_url),
          },
        ];
      }),
      messages: [],
      name: cellText(room.name),
      paused: false,
      roomId: cellText(room.id),
      topic: cellText(room.topic),
    })),
  };
  return yield* Schema.decodeUnknownEffect(LegacyDirectorySchema)(snapshot);
});

export const readRoomTables = (roomId: string) =>
  Effect.gen(function* () {
    if (!(yield* tablePresent("room_flags"))) {
      return;
    }
    const flags = yield* query("SELECT * FROM room_flags WHERE id = 1");
    const [flag] = flags;
    if (flag === undefined) {
      return;
    }
    const members = yield* query("SELECT * FROM members");
    const messages = yield* query("SELECT * FROM messages ORDER BY seq");
    const reactions = yield* whenPresent("reactions");
    const decoded = yield* Effect.forEach(messages, (message) =>
      messageOf(message, reactions)
    );
    return yield* Schema.decodeUnknownEffect(LegacyRoomSchema)({
      hopCount: cellNumber(flag.hop_count),
      leadId: cellText(flag.lead_id),
      members: members.map(memberOf),
      messages: decoded,
      name: cellText(flag.name),
      paused: cellNumber(flag.paused) === 1,
      roomId,
      topic: cellText(flag.topic),
    });
  });

const ensureCredentials = query(
  `CREATE TABLE IF NOT EXISTS credentials (
    agent_id TEXT PRIMARY KEY,
    admin INTEGER NOT NULL,
    webhook_secret TEXT NOT NULL,
    webhook_url TEXT
  )`
);

export const credentialRows = {
  get: (agentId: string) =>
    Effect.gen(function* () {
      if (!(yield* tablePresent("credentials"))) {
        return;
      }
      const rows = yield* query(
        "SELECT * FROM credentials WHERE agent_id = ?",
        agentId
      );
      const [row] = rows;
      if (row === undefined) {
        return;
      }
      const url = cellText(row.webhook_url);
      return {
        admin: cellNumber(row.admin) === 1,
        secret: cellText(row.webhook_secret),
        url: url.length === 0 ? null : url,
      } satisfies StoredCredential;
    }),
  put: (agentId: string, credential: StoredCredential) =>
    Effect.gen(function* () {
      yield* ensureCredentials;
      yield* query(
        `INSERT INTO credentials (agent_id, admin, webhook_secret, webhook_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           admin = excluded.admin,
           webhook_secret = excluded.webhook_secret,
           webhook_url = excluded.webhook_url`,
        agentId,
        credential.admin ? 1 : 0,
        credential.secret,
        credential.url
      );
    }),
};

import { Effect } from "effect";
import { decideAdmin } from "../domain/admin-auth.ts";
import {
  AgentNotFound,
  InvalidArgument,
  Unauthorized,
} from "../domain/errors.ts";
import {
  type AgentId,
  makeAgentId,
  type RequestId,
  type RoomId,
} from "../domain/ids.ts";
import { IdentityView } from "../domain/message.ts";
import type { SqlRow } from "../domain/sql-row.ts";
import { hashToken, makeSecret } from "../domain/token.ts";
import {
  AgentList,
  AgentRecord,
  type CreateAgentPayload,
  CreatedAgent,
  type GetAgentPayload,
  type ListAgentsPayload,
  type ResolvePayload,
  type RotateTokenPayload,
  type SetWebhookPayload,
  WebhookMaterial,
} from "./directory-http-api.ts";
import {
  decodeAgentId,
  decodeKind,
  decodeName,
  decodeRoomId,
  directoryQuery,
  forbidden,
  persist,
  requireWebhook,
} from "./directory-sql.ts";

const identityFrom = (row: SqlRow, requestId: RequestId) =>
  Effect.gen(function* () {
    const agentId = yield* decodeAgentId(row.id).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "directory.agent"))
      )
    );
    const kind = yield* decodeKind(row.kind).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(requestId, "directory.agent"))
      )
    );
    return new IdentityView({
      admin: Number(row.admin) === 1,
      agentId,
      displayName: String(row.display_name),
      kind,
    });
  });

const recordFrom = (row: SqlRow, requestId: RequestId) =>
  Effect.gen(function* () {
    const identity = yield* identityFrom(row, requestId);
    return new AgentRecord({
      admin: identity.admin,
      agentId: identity.agentId,
      displayName: identity.displayName,
      kind: identity.kind,
      webhookSecret: String(row.webhook_secret),
      webhookUrl: row.webhook_url === null ? null : String(row.webhook_url),
    });
  });

const findByHash = (requestId: RequestId, tokenHash: string) =>
  Effect.gen(function* () {
    const found = yield* directoryQuery(
      requestId,
      "SELECT * FROM agents WHERE token_hash = ?",
      tokenHash
    );
    const [row] = found;
    if (row === undefined) {
      return;
    }
    return yield* recordFrom(row, requestId);
  });

export const findById = (requestId: RequestId, agentId: AgentId) =>
  Effect.gen(function* () {
    const found = yield* directoryQuery(
      requestId,
      "SELECT * FROM agents WHERE id = ?",
      agentId
    );
    const [row] = found;
    if (row === undefined) {
      return;
    }
    return yield* recordFrom(row, requestId);
  });

const roomIdsFor = (requestId: RequestId, agentId: AgentId) =>
  Effect.gen(function* () {
    const found = yield* directoryQuery(
      requestId,
      "SELECT room_id FROM memberships WHERE agent_id = ?",
      agentId
    );
    const ids: RoomId[] = [];
    for (const row of found) {
      const id = yield* decodeRoomId(row.room_id).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(persist(requestId, "directory.membership"))
        )
      );
      ids.push(id);
    }
    return ids;
  });

export const resolve = Effect.fn("DirectoryServer.resolve")(function* (
  payload: ResolvePayload
) {
  const existing = yield* directoryQuery(
    payload.requestId,
    "SELECT * FROM agents WHERE admin = 1 LIMIT 1"
  );
  const [row] = existing;
  const storedHash = row === undefined ? undefined : String(row.token_hash);
  const decision = decideAdmin({
    envHash: payload.adminTokenHash,
    presentedHash: payload.tokenHash,
    storedHash,
  });
  if (decision === "accept" && row !== undefined) {
    return yield* identityFrom(row, payload.requestId);
  }
  if (decision === "bootstrap") {
    const name = yield* decodeName(payload.adminName).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new InvalidArgument({
            code: "InvalidArgument",
            details: {
              constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}",
              field: "adminName",
            },
            message:
              "AGENT_ROOMS_ADMIN_NAME must be a single mention token such as human.",
            operation: "authenticate",
            requestId: payload.requestId,
            retryable: false,
          })
        )
      )
    );
    const agentId = yield* makeAgentId().pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(persist(payload.requestId, "directory.agent"))
      )
    );
    const secret = yield* makeSecret();
    yield* directoryQuery(
      payload.requestId,
      `INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret)
       VALUES (?, ?, 'human', 1, ?, NULL, ?)`,
      agentId,
      name,
      payload.adminTokenHash,
      secret
    );
    return new IdentityView({
      admin: true,
      agentId,
      displayName: name,
      kind: "human",
    });
  }
  const agent = yield* findByHash(payload.requestId, payload.tokenHash);
  if (agent === undefined) {
    return yield* new Unauthorized({
      code: "Unauthorized",
      details: {},
      message:
        "The bearer token was not recognized. Check the token and retry.",
      operation: "authenticate",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  return new IdentityView({
    admin: agent.admin,
    agentId: agent.agentId,
    displayName: agent.displayName,
    kind: agent.kind,
  });
});

export const createAgent = Effect.fn("DirectoryServer.createAgent")(function* (
  payload: CreateAgentPayload
) {
  if (!payload.actor.admin) {
    return yield* forbidden(payload.requestId, "create_agent");
  }
  yield* requireWebhook(payload.requestId, "create_agent", payload.webhookUrl);
  const name = yield* decodeName(payload.displayName).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new InvalidArgument({
          code: "InvalidArgument",
          details: {
            constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}",
            field: "displayName",
          },
          message:
            "Display name must be one mention token, such as ada or coordinator.",
          operation: "create_agent",
          requestId: payload.requestId,
          retryable: false,
        })
      )
    )
  );
  const taken = yield* directoryQuery(
    payload.requestId,
    "SELECT id FROM agents WHERE display_name = ?",
    name
  );
  if (taken.length > 0) {
    return yield* new InvalidArgument({
      code: "InvalidArgument",
      details: { constraint: "must be unique", field: "displayName" },
      message: `An agent named ${name} already exists. Choose a different display name.`,
      operation: "create_agent",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  const agentId = yield* makeAgentId().pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(persist(payload.requestId, "directory.agent"))
    )
  );
  const token = yield* makeSecret();
  const tokenHash = yield* hashToken(token);
  const webhookSecret = yield* makeSecret();
  yield* directoryQuery(
    payload.requestId,
    `INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
    agentId,
    name,
    payload.kind,
    tokenHash,
    payload.webhookUrl,
    webhookSecret
  );
  return new CreatedAgent({
    agent: new IdentityView({
      admin: false,
      agentId,
      displayName: name,
      kind: payload.kind,
    }),
    token,
    webhookSecret,
  });
});

export const listAgents = Effect.fn("DirectoryServer.listAgents")(function* (
  payload: ListAgentsPayload
) {
  if (!payload.actor.admin) {
    return yield* forbidden(payload.requestId, "list_agents");
  }
  const found = yield* directoryQuery(
    payload.requestId,
    "SELECT * FROM agents ORDER BY display_name"
  );
  const agents: IdentityView[] = [];
  for (const row of found) {
    agents.push(yield* identityFrom(row, payload.requestId));
  }
  return new AgentList({ agents });
});

export const rotateToken = Effect.fn("DirectoryServer.rotateToken")(function* (
  payload: RotateTokenPayload
) {
  if (!payload.actor.admin && payload.actor.agentId !== payload.agentId) {
    return yield* forbidden(payload.requestId, "rotate_token");
  }
  const agent = yield* findById(payload.requestId, payload.agentId);
  if (agent === undefined) {
    return yield* new AgentNotFound({
      code: "AgentNotFound",
      details: { agentId: payload.agentId },
      message: `Agent ${payload.agentId} was not found. Check the id and retry.`,
      operation: "agent.read",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  const token = yield* makeSecret();
  const tokenHash = yield* hashToken(token);
  yield* directoryQuery(
    payload.requestId,
    "UPDATE agents SET token_hash = ? WHERE id = ?",
    tokenHash,
    payload.agentId
  );
  return new CreatedAgent({
    agent: new IdentityView({
      admin: agent.admin,
      agentId: agent.agentId,
      displayName: agent.displayName,
      kind: agent.kind,
    }),
    token,
    webhookSecret: agent.webhookSecret,
  });
});

export const setWebhook = Effect.fn("DirectoryServer.setWebhook")(function* (
  payload: SetWebhookPayload
) {
  yield* requireWebhook(
    payload.requestId,
    "register_webhook",
    payload.webhookUrl
  );
  const target = payload.actor.agentId;
  const agent = yield* findById(payload.requestId, target);
  if (agent === undefined) {
    return yield* forbidden(payload.requestId, "register_webhook");
  }
  yield* directoryQuery(
    payload.requestId,
    "UPDATE agents SET webhook_url = ? WHERE id = ?",
    payload.webhookUrl,
    target
  );
  return new WebhookMaterial({
    roomIds: yield* roomIdsFor(payload.requestId, target),
    webhookSecret: agent.webhookSecret,
    webhookUrl: payload.webhookUrl,
  });
});

export const getAgent = Effect.fn("DirectoryServer.getAgent")(function* (
  payload: GetAgentPayload
) {
  const agent = yield* findById(payload.requestId, payload.agentId);
  if (agent === undefined) {
    return yield* new AgentNotFound({
      code: "AgentNotFound",
      details: { agentId: payload.agentId },
      message: `Agent ${payload.agentId} was not found. Check the id and retry.`,
      operation: "agent.read",
      requestId: payload.requestId,
      retryable: false,
    });
  }
  return agent;
});

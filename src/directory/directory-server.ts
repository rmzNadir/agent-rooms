import * as Cloudflare from "alchemy/Cloudflare"
import * as AlchemyHttp from "alchemy/Http"
import { Effect, Layer, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpRouter } from "effect/http"
import { DisplayName } from "../domain/actor.ts"
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  PersistenceFailed,
  RoomNameTaken,
  Unauthorized,
} from "../domain/errors.ts"
import { AgentId, makeAgentId, type RequestId, RoomId } from "../domain/ids.ts"
import { IdentityView, RoomSummary } from "../domain/message.ts"
import { hashToken, makeSecret } from "../domain/token.ts"
import { webhookUrlProblem } from "../domain/webhook-url.ts"
import {
  AgentList,
  AgentRecord,
  CreatedAgent,
  type CreateAgentPayload,
  type DeleteMembershipPayload,
  type DeleteRoomPayload,
  DirectoryAck,
  DirectoryHttpApi,
  type GetAgentPayload,
  type ListAgentsPayload,
  type ListRoomsPayload,
  type PutMembershipPayload,
  type PutRoomPayload,
  type ResolvePayload,
  type RotateTokenPayload,
  RoomList,
  type SetWebhookPayload,
  WebhookMaterial,
} from "./directory-http-api.ts"

const decodeAgentId = Schema.decodeUnknownEffect(AgentId)
const decodeRoomId = Schema.decodeUnknownEffect(RoomId)
const decodeName = Schema.decodeUnknownEffect(DisplayName)
const decodeKind = Schema.decodeUnknownEffect(Schema.Literals(["agent", "human"]))

const persist = (requestId: RequestId, operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    operation,
    message: "The directory could not save that change. Retry the same request.",
    requestId,
    details: {},
    retryable: true,
  })

const forbidden = (requestId: RequestId, operation: string) =>
  new Forbidden({
    code: "Forbidden",
    operation,
    message: "That action is limited to the admin human. Use an admin token and retry.",
    requestId,
    details: {},
    retryable: false,
  })

const requireWebhook = (requestId: RequestId, operation: string, webhookUrl: string | null) => {
  if (webhookUrl === null) return Effect.void
  const problem = webhookUrlProblem(webhookUrl)
  if (problem === undefined) return Effect.void
  return Effect.fail(
    new InvalidArgument({
      code: "InvalidArgument",
      operation,
      message: `Webhook URL ${problem}. Use https, or http://127.0.0.1 for a local listener.`,
      requestId,
      details: { field: "webhookUrl", constraint: problem },
      retryable: false,
    }),
  )
}

export default class DirectoryServer extends Cloudflare.DurableObject<DirectoryServer>()(
  "DirectoryServer",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const query = (requestId: RequestId, sql: string, ...bindings: Array<string | number | null>) =>
        Effect.gen(function* () {
          const current = yield* Cloudflare.DurableObjectState
          const cursor = yield* current.storage.sql
            .exec<Record<string, string | number | null>>(sql, ...bindings)
            .pipe(Effect.catchDefect(() => Effect.fail(persist(requestId, "directory.sql"))))
          return yield* cursor.toArray().pipe(
            Effect.catchDefect(() => Effect.fail(persist(requestId, "directory.sql"))),
          )
        })

      yield* Effect.gen(function* () {
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
        ]
        for (const statement of statements) {
          const current = yield* Cloudflare.DurableObjectState
          yield* current.storage.sql.exec(statement).pipe(
            Effect.catchDefect(() => Effect.die("directory schema failed")),
          )
        }
      })

      const identityFrom = (row: Record<string, string | number | null>, requestId: RequestId) =>
        Effect.gen(function* () {
          const agentId = yield* decodeAgentId(row.id).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "directory.agent"))),
          )
          const kind = yield* decodeKind(row.kind).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "directory.agent"))),
          )
          return new IdentityView({
            agentId,
            displayName: String(row.display_name),
            kind,
            admin: Number(row.admin) === 1,
          })
        })

      const recordFrom = (row: Record<string, string | number | null>, requestId: RequestId) =>
        Effect.gen(function* () {
          const identity = yield* identityFrom(row, requestId)
          return new AgentRecord({
            agentId: identity.agentId,
            displayName: identity.displayName,
            kind: identity.kind,
            admin: identity.admin,
            webhookUrl: row.webhook_url === null ? null : String(row.webhook_url),
            webhookSecret: String(row.webhook_secret),
          })
        })

      const findByHash = (requestId: RequestId, tokenHash: string) =>
        Effect.gen(function* () {
          const found = yield* query(requestId, "SELECT * FROM agents WHERE token_hash = ?", tokenHash)
          const row = found[0]
          if (row === undefined) return undefined
          return yield* recordFrom(row, requestId)
        })

      const findById = (requestId: RequestId, agentId: AgentId) =>
        Effect.gen(function* () {
          const found = yield* query(requestId, "SELECT * FROM agents WHERE id = ?", agentId)
          const row = found[0]
          if (row === undefined) return undefined
          return yield* recordFrom(row, requestId)
        })

      const roomIdsFor = (requestId: RequestId, agentId: AgentId) =>
        Effect.gen(function* () {
          const found = yield* query(
            requestId,
            "SELECT room_id FROM memberships WHERE agent_id = ?",
            agentId,
          )
          const ids: RoomId[] = []
          for (const row of found) {
            const id = yield* decodeRoomId(row.room_id).pipe(
              Effect.catchTag("SchemaError", () => Effect.fail(persist(requestId, "directory.membership"))),
            )
            ids.push(id)
          }
          return ids
        })

      const resolve = Effect.fn("DirectoryServer.resolve")(function* (payload: ResolvePayload) {
        if (payload.tokenHash === payload.adminTokenHash) {
          const existing = yield* query(payload.requestId, "SELECT * FROM agents WHERE admin = 1 LIMIT 1")
          const row = existing[0]
          if (row !== undefined) return yield* identityFrom(row, payload.requestId)
          const name = yield* decodeName(payload.adminName).pipe(
            Effect.catchTag("SchemaError", () =>
              Effect.fail(
                new InvalidArgument({
                  code: "InvalidArgument",
                  operation: "authenticate",
                  message: "AGENT_ROOMS_ADMIN_NAME must be a single mention token such as human.",
                  requestId: payload.requestId,
                  details: { field: "adminName", constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}" },
                  retryable: false,
                }),
              ),
            ),
          )
          const agentId = yield* makeAgentId().pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(payload.requestId, "directory.agent"))),
          )
          const secret = yield* makeSecret()
          yield* query(
            payload.requestId,
            `INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret)
             VALUES (?, ?, 'human', 1, ?, NULL, ?)`,
            agentId,
            name,
            payload.adminTokenHash,
            secret,
          )
          return new IdentityView({ agentId, displayName: name, kind: "human", admin: true })
        }
        const agent = yield* findByHash(payload.requestId, payload.tokenHash)
        if (agent === undefined) {
          return yield* new Unauthorized({
            code: "Unauthorized",
            operation: "authenticate",
            message: "The bearer token was not recognized. Check the token and retry.",
            requestId: payload.requestId,
            details: {},
            retryable: false,
          })
        }
        return new IdentityView({
          agentId: agent.agentId,
          displayName: agent.displayName,
          kind: agent.kind,
          admin: agent.admin,
        })
      })

      const createAgent = Effect.fn("DirectoryServer.createAgent")(function* (payload: CreateAgentPayload) {
        if (!payload.actor.admin) return yield* forbidden(payload.requestId, "create_agent")
        yield* requireWebhook(payload.requestId, "create_agent", payload.webhookUrl)
        const name = yield* decodeName(payload.displayName).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new InvalidArgument({
                code: "InvalidArgument",
                operation: "create_agent",
                message: "Display name must be one mention token, such as ada or coordinator.",
                requestId: payload.requestId,
                details: { field: "displayName", constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}" },
                retryable: false,
              }),
            ),
          ),
        )
        const taken = yield* query(payload.requestId, "SELECT id FROM agents WHERE display_name = ?", name)
        if (taken.length > 0) {
          return yield* new InvalidArgument({
            code: "InvalidArgument",
            operation: "create_agent",
            message: `An agent named ${name} already exists. Choose a different display name.`,
            requestId: payload.requestId,
            details: { field: "displayName", constraint: "must be unique" },
            retryable: false,
          })
        }
        const agentId = yield* makeAgentId().pipe(
          Effect.catchTag("SchemaError", () => Effect.fail(persist(payload.requestId, "directory.agent"))),
        )
        const token = yield* makeSecret()
        const tokenHash = yield* hashToken(token)
        const webhookSecret = yield* makeSecret()
        yield* query(
          payload.requestId,
          `INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
          agentId,
          name,
          payload.kind,
          tokenHash,
          payload.webhookUrl,
          webhookSecret,
        )
        return new CreatedAgent({
          token,
          webhookSecret,
          agent: new IdentityView({
            agentId,
            displayName: name,
            kind: payload.kind,
            admin: false,
          }),
        })
      })

      const listAgents = Effect.fn("DirectoryServer.listAgents")(function* (payload: ListAgentsPayload) {
        if (!payload.actor.admin) return yield* forbidden(payload.requestId, "list_agents")
        const found = yield* query(payload.requestId, "SELECT * FROM agents ORDER BY display_name")
        const agents: IdentityView[] = []
        for (const row of found) agents.push(yield* identityFrom(row, payload.requestId))
        return new AgentList({ agents })
      })

      const rotateToken = Effect.fn("DirectoryServer.rotateToken")(function* (payload: RotateTokenPayload) {
        if (!payload.actor.admin && payload.actor.agentId !== payload.agentId) {
          return yield* forbidden(payload.requestId, "rotate_token")
        }
        const agent = yield* findById(payload.requestId, payload.agentId)
        if (agent === undefined) {
          return yield* new AgentNotFound({
            code: "AgentNotFound",
            operation: "agent.read",
            message: `Agent ${payload.agentId} was not found. Check the id and retry.`,
            requestId: payload.requestId,
            details: { agentId: payload.agentId },
            retryable: false,
          })
        }
        const token = yield* makeSecret()
        const tokenHash = yield* hashToken(token)
        yield* query(payload.requestId, "UPDATE agents SET token_hash = ? WHERE id = ?", tokenHash, payload.agentId)
        return new CreatedAgent({
          token,
          webhookSecret: agent.webhookSecret,
          agent: new IdentityView({
            agentId: agent.agentId,
            displayName: agent.displayName,
            kind: agent.kind,
            admin: agent.admin,
          }),
        })
      })

      const setWebhook = Effect.fn("DirectoryServer.setWebhook")(function* (payload: SetWebhookPayload) {
        yield* requireWebhook(payload.requestId, "register_webhook", payload.webhookUrl)
        const target = payload.actor.agentId
        const agent = yield* findById(payload.requestId, target)
        if (agent === undefined) return yield* forbidden(payload.requestId, "register_webhook")
        yield* query(
          payload.requestId,
          "UPDATE agents SET webhook_url = ? WHERE id = ?",
          payload.webhookUrl,
          target,
        )
        return new WebhookMaterial({
          webhookUrl: payload.webhookUrl,
          webhookSecret: agent.webhookSecret,
          roomIds: yield* roomIdsFor(payload.requestId, target),
        })
      })

      const putRoom = Effect.fn("DirectoryServer.putRoom")(function* (payload: PutRoomPayload) {
        const clash = yield* query(
          payload.requestId,
          "SELECT id FROM rooms WHERE name = ? AND id != ?",
          payload.name,
          payload.roomId,
        )
        if (clash.length > 0) {
          return yield* new RoomNameTaken({
            code: "RoomNameTaken",
            operation: "create_room",
            message: `A room named ${payload.name} already exists. Choose a different name.`,
            requestId: payload.requestId,
            details: { name: payload.name },
            retryable: false,
          })
        }
        yield* query(
          payload.requestId,
          `INSERT INTO rooms (id, name, topic, lead_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, topic = excluded.topic, lead_id = excluded.lead_id`,
          payload.roomId,
          payload.name,
          payload.topic,
          payload.leadId,
        )
        return new RoomSummary({
          roomId: payload.roomId,
          name: payload.name,
          topic: payload.topic,
          leadId: payload.leadId,
          youAreLead: payload.leadId === payload.actor.agentId,
        })
      })

      const deleteRoom = Effect.fn("DirectoryServer.deleteRoom")(function* (payload: DeleteRoomPayload) {
        yield* query(payload.requestId, "DELETE FROM memberships WHERE room_id = ?", payload.roomId)
        yield* query(payload.requestId, "DELETE FROM rooms WHERE id = ?", payload.roomId)
        return new DirectoryAck({ ok: true })
      })

      const listRooms = Effect.fn("DirectoryServer.listRooms")(function* (payload: ListRoomsPayload) {
        const found = payload.actor.admin
          ? yield* query(payload.requestId, "SELECT * FROM rooms ORDER BY name")
          : yield* query(
              payload.requestId,
              `SELECT rooms.* FROM rooms
               JOIN memberships ON memberships.room_id = rooms.id
               WHERE memberships.agent_id = ?
               ORDER BY rooms.name`,
              payload.actor.agentId,
            )
        const rooms: RoomSummary[] = []
        for (const row of found) {
          const roomId = yield* decodeRoomId(row.id).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(payload.requestId, "directory.rooms"))),
          )
          const leadId = yield* decodeAgentId(row.lead_id).pipe(
            Effect.catchTag("SchemaError", () => Effect.fail(persist(payload.requestId, "directory.rooms"))),
          )
          rooms.push(
            new RoomSummary({
              roomId,
              name: String(row.name),
              topic: String(row.topic),
              leadId,
              youAreLead: leadId === payload.actor.agentId,
            }),
          )
        }
        return new RoomList({ rooms })
      })

      const putMembership = Effect.fn("DirectoryServer.putMembership")(function* (payload: PutMembershipPayload) {
        const agent = yield* findById(payload.requestId, payload.agentId)
        if (agent === undefined) {
          return yield* new AgentNotFound({
            code: "AgentNotFound",
            operation: "agent.read",
            message: `Agent ${payload.agentId} was not found. Create the agent before inviting them.`,
            requestId: payload.requestId,
            details: { agentId: payload.agentId },
            retryable: false,
          })
        }
        yield* query(
          payload.requestId,
          "INSERT INTO memberships (room_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          payload.roomId,
          payload.agentId,
        )
        return new DirectoryAck({ ok: true })
      })

      const deleteMembership = Effect.fn("DirectoryServer.deleteMembership")(function* (
        payload: DeleteMembershipPayload,
      ) {
        yield* query(
          payload.requestId,
          "DELETE FROM memberships WHERE room_id = ? AND agent_id = ?",
          payload.roomId,
          payload.agentId,
        )
        return new DirectoryAck({ ok: true })
      })

      const getAgent = Effect.fn("DirectoryServer.getAgent")(function* (payload: GetAgentPayload) {
        const agent = yield* findById(payload.requestId, payload.agentId)
        if (agent === undefined) {
          return yield* new AgentNotFound({
            code: "AgentNotFound",
            operation: "agent.read",
            message: `Agent ${payload.agentId} was not found. Check the id and retry.`,
            requestId: payload.requestId,
            details: { agentId: payload.agentId },
            retryable: false,
          })
        }
        return agent
      })

      const handlers = HttpApiBuilder.group(DirectoryHttpApi, "directory", (group) =>
        group
          .handle("resolve", ({ payload }) => resolve(payload))
          .handle("createAgent", ({ payload }) => createAgent(payload))
          .handle("listAgents", ({ payload }) => listAgents(payload))
          .handle("rotateToken", ({ payload }) => rotateToken(payload))
          .handle("setWebhook", ({ payload }) => setWebhook(payload))
          .handle("putRoom", ({ payload }) => putRoom(payload))
          .handle("deleteRoom", ({ payload }) => deleteRoom(payload))
          .handle("listRooms", ({ payload }) => listRooms(payload))
          .handle("putMembership", ({ payload }) => putMembership(payload))
          .handle("deleteMembership", ({ payload }) => deleteMembership(payload))
          .handle("getAgent", ({ payload }) => getAgent(payload)),
      )

      return {
        fetch: Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* HttpRouter.toHttpEffect(
              HttpApiBuilder.layer(DirectoryHttpApi).pipe(
                Layer.provide(handlers),
                Layer.provide(AlchemyHttp.Platform),
              ),
            )
            return yield* handle
          }),
        ),
      }
    })
  }),
) {}

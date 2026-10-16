import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { Actor, MemberKind } from "../domain/actor.ts"
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  LeadRequired,
  PersistenceFailed,
  RoomNameTaken,
  Unauthorized,
} from "../domain/errors.ts"
import { AgentId, RequestId, RoomId } from "../domain/ids.ts"
import { IdentityView, RoomSummary } from "../domain/message.ts"

/** Resolve a bearer-token hash, bootstrapping the admin human on first use. */
export class ResolvePayload extends Schema.Class<ResolvePayload>("ResolvePayload")({
  requestId: RequestId,
  tokenHash: Schema.String,
  adminTokenHash: Schema.String,
  adminName: Schema.String,
}) {}

/** Create an agent. The plaintext token is returned once. */
export class CreateAgentPayload extends Schema.Class<CreateAgentPayload>("CreateAgentPayload")({
  requestId: RequestId,
  actor: Actor,
  displayName: Schema.String,
  kind: MemberKind,
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

/** Agent plus the secrets that are shown only at creation or rotation. */
export class CreatedAgent extends Schema.Class<CreatedAgent>("CreatedAgent")({
  agent: IdentityView,
  token: Schema.String,
  webhookSecret: Schema.String,
}) {}

/** List agents. Admin only. */
export class ListAgentsPayload extends Schema.Class<ListAgentsPayload>("ListAgentsPayload")({
  requestId: RequestId,
  actor: Actor,
}) {}

/** Agents without secrets. */
export class AgentList extends Schema.Class<AgentList>("AgentList")({
  agents: Schema.Array(IdentityView),
}) {}

/** Replace the bearer token. The new token is returned once. */
export class RotateTokenPayload extends Schema.Class<RotateTokenPayload>("RotateTokenPayload")({
  requestId: RequestId,
  actor: Actor,
  agentId: AgentId,
}) {}

/** Point an agent's wake webhook at a URL. The signing secret is unchanged. */
export class SetWebhookPayload extends Schema.Class<SetWebhookPayload>("SetWebhookPayload")({
  requestId: RequestId,
  actor: Actor,
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

/** Webhook material the room copies onto a membership. Not returned by MCP. */
export class WebhookMaterial extends Schema.Class<WebhookMaterial>("WebhookMaterial")({
  webhookUrl: Schema.NullOr(Schema.String),
  webhookSecret: Schema.String,
  roomIds: Schema.Array(RoomId),
}) {}

/** What `register_webhook` returns. The signing secret stays on the directory. */
export class WebhookRegistration extends Schema.Class<WebhookRegistration>("WebhookRegistration")({
  webhookUrl: Schema.NullOr(Schema.String),
  roomIds: Schema.Array(RoomId),
}) {}

/** Insert or replace a room catalog row. */
export class PutRoomPayload extends Schema.Class<PutRoomPayload>("PutRoomPayload")({
  requestId: RequestId,
  actor: Actor,
  roomId: RoomId,
  name: Schema.String,
  topic: Schema.String,
  leadId: AgentId,
}) {}

/** Remove a catalog row after a failed room init. */
export class DeleteRoomPayload extends Schema.Class<DeleteRoomPayload>("DeleteRoomPayload")({
  requestId: RequestId,
  roomId: RoomId,
}) {}

/** Rooms visible to the caller. */
export class ListRoomsPayload extends Schema.Class<ListRoomsPayload>("ListRoomsPayload")({
  requestId: RequestId,
  actor: Actor,
}) {}

/** Room catalog page. */
export class RoomList extends Schema.Class<RoomList>("RoomList")({
  rooms: Schema.Array(RoomSummary),
}) {}

/** Record that an agent belongs to a room. */
export class PutMembershipPayload extends Schema.Class<PutMembershipPayload>("PutMembershipPayload")({
  requestId: RequestId,
  roomId: RoomId,
  agentId: AgentId,
}) {}

/** Drop a catalog membership. */
export class DeleteMembershipPayload extends Schema.Class<DeleteMembershipPayload>("DeleteMembershipPayload")({
  requestId: RequestId,
  roomId: RoomId,
  agentId: AgentId,
}) {}

/** Load one agent, including webhook material for room setup. */
export class GetAgentPayload extends Schema.Class<GetAgentPayload>("GetAgentPayload")({
  requestId: RequestId,
  agentId: AgentId,
}) {}

/** Agent record used while creating and inviting. The secret stays inside the worker. */
export class AgentRecord extends Schema.Class<AgentRecord>("AgentRecord")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  admin: Schema.Boolean,
  webhookUrl: Schema.NullOr(Schema.String),
  webhookSecret: Schema.String,
}) {}

/** Empty acknowledgement. */
export class DirectoryAck extends Schema.Class<DirectoryAck>("DirectoryAck")({
  ok: Schema.Literal(true),
}) {}

const failure = [Forbidden, InvalidArgument, PersistenceFailed, AgentNotFound] as const

const resolve = HttpApiEndpoint.post("resolve", "/v1/resolve", {
  payload: ResolvePayload,
  success: IdentityView,
  error: [Unauthorized, PersistenceFailed, InvalidArgument],
})

const createAgent = HttpApiEndpoint.post("createAgent", "/v1/agents", {
  payload: CreateAgentPayload,
  success: CreatedAgent,
  error: failure,
})

const listAgents = HttpApiEndpoint.post("listAgents", "/v1/agents/list", {
  payload: ListAgentsPayload,
  success: AgentList,
  error: [Forbidden, PersistenceFailed],
})

const rotateToken = HttpApiEndpoint.post("rotateToken", "/v1/agents/rotate", {
  payload: RotateTokenPayload,
  success: CreatedAgent,
  error: failure,
})

const setWebhook = HttpApiEndpoint.post("setWebhook", "/v1/agents/webhook", {
  payload: SetWebhookPayload,
  success: WebhookMaterial,
  error: [Forbidden, PersistenceFailed, InvalidArgument],
})

const putRoom = HttpApiEndpoint.post("putRoom", "/v1/rooms", {
  payload: PutRoomPayload,
  success: RoomSummary,
  error: [RoomNameTaken, LeadRequired, PersistenceFailed, InvalidArgument],
})

const deleteRoom = HttpApiEndpoint.post("deleteRoom", "/v1/rooms/delete", {
  payload: DeleteRoomPayload,
  success: DirectoryAck,
  error: [PersistenceFailed],
})

const listRooms = HttpApiEndpoint.post("listRooms", "/v1/rooms/list", {
  payload: ListRoomsPayload,
  success: RoomList,
  error: [PersistenceFailed],
})

const putMembership = HttpApiEndpoint.post("putMembership", "/v1/memberships", {
  payload: PutMembershipPayload,
  success: DirectoryAck,
  error: [PersistenceFailed, AgentNotFound],
})

const deleteMembership = HttpApiEndpoint.post("deleteMembership", "/v1/memberships/delete", {
  payload: DeleteMembershipPayload,
  success: DirectoryAck,
  error: [PersistenceFailed],
})

const getAgent = HttpApiEndpoint.post("getAgent", "/v1/agents/get", {
  payload: GetAgentPayload,
  success: AgentRecord,
  error: [AgentNotFound, PersistenceFailed],
})

/** Versioned HTTP contract for the singleton directory Durable Object. */
export class DirectoryGroup extends HttpApiGroup.make("directory")
  .add(resolve)
  .add(createAgent)
  .add(listAgents)
  .add(rotateToken)
  .add(setWebhook)
  .add(putRoom)
  .add(deleteRoom)
  .add(listRooms)
  .add(putMembership)
  .add(deleteMembership)
  .add(getAgent) {}

/** Directory HTTP API. One Durable Object named `directory` serves it. */
export class DirectoryHttpApi extends HttpApi.make("DirectoryHttpApi").add(DirectoryGroup) {}

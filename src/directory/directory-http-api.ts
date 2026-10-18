import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Actor, MemberKind } from "../domain/actor.ts";
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  LeadRequired,
  PersistenceFailed,
  RoomNameTaken,
  Unauthorized,
} from "../domain/errors.ts";
import { AgentId, RequestId, RoomId } from "../domain/ids.ts";
import { IdentityView, RoomSummary } from "../domain/message.ts";

export class ResolvePayload extends Schema.Class<ResolvePayload>(
  "ResolvePayload"
)({
  adminName: Schema.String,
  adminTokenHash: Schema.String,
  requestId: RequestId,
  tokenHash: Schema.String,
}) {}

export class CreateAgentPayload extends Schema.Class<CreateAgentPayload>(
  "CreateAgentPayload"
)({
  actor: Actor,
  displayName: Schema.String,
  kind: MemberKind,
  requestId: RequestId,
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class CreatedAgent extends Schema.Class<CreatedAgent>("CreatedAgent")({
  agent: IdentityView,
  token: Schema.String,
  webhookSecret: Schema.String,
}) {}

export class ListAgentsPayload extends Schema.Class<ListAgentsPayload>(
  "ListAgentsPayload"
)({
  actor: Actor,
  requestId: RequestId,
}) {}

export class AgentList extends Schema.Class<AgentList>("AgentList")({
  agents: Schema.Array(IdentityView),
}) {}

export class RotateTokenPayload extends Schema.Class<RotateTokenPayload>(
  "RotateTokenPayload"
)({
  actor: Actor,
  agentId: AgentId,
  requestId: RequestId,
}) {}

export class SetWebhookPayload extends Schema.Class<SetWebhookPayload>(
  "SetWebhookPayload"
)({
  actor: Actor,
  requestId: RequestId,
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class WebhookMaterial extends Schema.Class<WebhookMaterial>(
  "WebhookMaterial"
)({
  roomIds: Schema.Array(RoomId),
  webhookSecret: Schema.String,
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class WebhookRegistration extends Schema.Class<WebhookRegistration>(
  "WebhookRegistration"
)({
  roomIds: Schema.Array(RoomId),
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class PutRoomPayload extends Schema.Class<PutRoomPayload>(
  "PutRoomPayload"
)({
  actor: Actor,
  leadId: AgentId,
  memberIds: Schema.optional(Schema.Array(AgentId)),
  name: Schema.String,
  requestId: RequestId,
  roomId: RoomId,
  topic: Schema.String,
}) {}

export class DeleteRoomPayload extends Schema.Class<DeleteRoomPayload>(
  "DeleteRoomPayload"
)({
  requestId: RequestId,
  roomId: RoomId,
}) {}

export class ListRoomsPayload extends Schema.Class<ListRoomsPayload>(
  "ListRoomsPayload"
)({
  actor: Actor,
  requestId: RequestId,
}) {}

export class RoomList extends Schema.Class<RoomList>("RoomList")({
  rooms: Schema.Array(RoomSummary),
}) {}

export class PutMembershipPayload extends Schema.Class<PutMembershipPayload>(
  "PutMembershipPayload"
)({
  agentId: AgentId,
  requestId: RequestId,
  roomId: RoomId,
}) {}

export class DeleteMembershipPayload extends Schema.Class<DeleteMembershipPayload>(
  "DeleteMembershipPayload"
)({
  agentId: AgentId,
  requestId: RequestId,
  roomId: RoomId,
}) {}

export class GetAgentPayload extends Schema.Class<GetAgentPayload>(
  "GetAgentPayload"
)({
  agentId: AgentId,
  requestId: RequestId,
}) {}

export class AgentRecord extends Schema.Class<AgentRecord>("AgentRecord")({
  admin: Schema.Boolean,
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  webhookSecret: Schema.String,
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class DirectoryAck extends Schema.Class<DirectoryAck>("DirectoryAck")({
  ok: Schema.Literal(true),
}) {}

const failure = [
  Forbidden,
  InvalidArgument,
  PersistenceFailed,
  AgentNotFound,
] as const;

const resolve = HttpApiEndpoint.post("resolve", "/v1/resolve", {
  error: [Unauthorized, PersistenceFailed, InvalidArgument],
  payload: ResolvePayload,
  success: IdentityView,
});

const createAgent = HttpApiEndpoint.post("createAgent", "/v1/agents", {
  error: failure,
  payload: CreateAgentPayload,
  success: CreatedAgent,
});

const listAgents = HttpApiEndpoint.post("listAgents", "/v1/agents/list", {
  error: [Forbidden, PersistenceFailed],
  payload: ListAgentsPayload,
  success: AgentList,
});

const rotateToken = HttpApiEndpoint.post("rotateToken", "/v1/agents/rotate", {
  error: failure,
  payload: RotateTokenPayload,
  success: CreatedAgent,
});

const setWebhook = HttpApiEndpoint.post("setWebhook", "/v1/agents/webhook", {
  error: [Forbidden, PersistenceFailed, InvalidArgument],
  payload: SetWebhookPayload,
  success: WebhookMaterial,
});

const putRoom = HttpApiEndpoint.post("putRoom", "/v1/rooms", {
  error: [RoomNameTaken, LeadRequired, PersistenceFailed, InvalidArgument],
  payload: PutRoomPayload,
  success: RoomSummary,
});

const deleteRoom = HttpApiEndpoint.post("deleteRoom", "/v1/rooms/delete", {
  error: [PersistenceFailed],
  payload: DeleteRoomPayload,
  success: DirectoryAck,
});

const listRooms = HttpApiEndpoint.post("listRooms", "/v1/rooms/list", {
  error: [PersistenceFailed],
  payload: ListRoomsPayload,
  success: RoomList,
});

const putMembership = HttpApiEndpoint.post("putMembership", "/v1/memberships", {
  error: [PersistenceFailed, AgentNotFound],
  payload: PutMembershipPayload,
  success: DirectoryAck,
});

const deleteMembership = HttpApiEndpoint.post(
  "deleteMembership",
  "/v1/memberships/delete",
  {
    error: [PersistenceFailed],
    payload: DeleteMembershipPayload,
    success: DirectoryAck,
  }
);

const getAgent = HttpApiEndpoint.post("getAgent", "/v1/agents/get", {
  error: [AgentNotFound, PersistenceFailed],
  payload: GetAgentPayload,
  success: AgentRecord,
});

class DirectoryGroup extends HttpApiGroup.make("directory")
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

export class DirectoryHttpApi extends HttpApi.make("DirectoryHttpApi").add(
  DirectoryGroup
) {}

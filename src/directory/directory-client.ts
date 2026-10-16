import * as Cloudflare from "alchemy/Cloudflare"
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo"
import { Context, Effect, Layer, Schema } from "effect"
import type { HttpClientError } from "effect/http/HttpClientError"
import { HttpApiClient } from "effect/http-api"
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  LeadRequired,
  PersistenceFailed,
  RoomNameTaken,
  Unauthorized,
  Unavailable,
} from "../domain/errors.ts"
import type { RequestId } from "../domain/ids.ts"
import { IdentityView, type RoomSummary } from "../domain/message.ts"
import {
  AgentList,
  AgentRecord,
  CreateAgentPayload,
  CreatedAgent,
  DeleteMembershipPayload,
  DeleteRoomPayload,
  DirectoryAck,
  DirectoryHttpApi,
  GetAgentPayload,
  ListAgentsPayload,
  ListRoomsPayload,
  PutMembershipPayload,
  PutRoomPayload,
  ResolvePayload,
  RotateTokenPayload,
  RoomList,
  SetWebhookPayload,
  WebhookMaterial,
} from "./directory-http-api.ts"
import DirectoryServer from "./directory-server.ts"

export type DirectoryCallError =
  | Unavailable
  | Unauthorized
  | PersistenceFailed
  | InvalidArgument
  | Forbidden
  | AgentNotFound
  | RoomNameTaken
  | LeadRequired

type TransportError = DirectoryCallError | HttpClientError | Schema.SchemaError

const down = (requestId: RequestId, operation: string) =>
  new Unavailable({
    code: "Unavailable",
    operation,
    message: "The directory did not respond. Retry the same request.",
    requestId,
    details: {},
    retryable: true,
  })

const settle = <A>(effect: Effect.Effect<A, TransportError>, requestId: RequestId, operation: string) =>
  Effect.catchTags(effect, {
    HttpClientError: () => Effect.fail(down(requestId, operation)),
    SchemaError: () => Effect.fail(down(requestId, operation)),
  })

const prepare = <A>(schema: Schema.Decoder<A>, payload: { readonly requestId: RequestId }, operation: string) =>
  Effect.catchTag(Schema.decodeUnknownEffect(schema)(payload), "SchemaError", () =>
    Effect.fail(down(payload.requestId, operation)),
  )

export interface IDirectoryClient {
  readonly resolve: (payload: ResolvePayload) => Effect.Effect<IdentityView, DirectoryCallError>
  readonly createAgent: (payload: CreateAgentPayload) => Effect.Effect<CreatedAgent, DirectoryCallError>
  readonly listAgents: (payload: ListAgentsPayload) => Effect.Effect<AgentList, DirectoryCallError>
  readonly rotateToken: (payload: RotateTokenPayload) => Effect.Effect<CreatedAgent, DirectoryCallError>
  readonly setWebhook: (payload: SetWebhookPayload) => Effect.Effect<WebhookMaterial, DirectoryCallError>
  readonly putRoom: (payload: PutRoomPayload) => Effect.Effect<RoomSummary, DirectoryCallError>
  readonly deleteRoom: (payload: DeleteRoomPayload) => Effect.Effect<DirectoryAck, DirectoryCallError>
  readonly listRooms: (payload: ListRoomsPayload) => Effect.Effect<RoomList, DirectoryCallError>
  readonly putMembership: (payload: PutMembershipPayload) => Effect.Effect<DirectoryAck, DirectoryCallError>
  readonly deleteMembership: (payload: DeleteMembershipPayload) => Effect.Effect<DirectoryAck, DirectoryCallError>
  readonly getAgent: (payload: GetAgentPayload) => Effect.Effect<AgentRecord, DirectoryCallError>
}

export class DirectoryClient extends Context.Service<DirectoryClient, IDirectoryClient>()(
  "@agent-rooms/DirectoryClient",
) {}

const directoryName = "directory"

export const makeDirectoryClient = Effect.gen(function* () {
  const namespace = yield* DirectoryServer
  const clientEffect = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(DirectoryHttpApi, {
        baseUrl: "http://directory.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName(directoryName)),
      }),
    ),
  )

  return DirectoryClient.of({
    resolve: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(ResolvePayload, payload, "authenticate")
        const client = yield* clientEffect
        return yield* settle(client.directory.resolve({ payload: body }), payload.requestId, "authenticate")
      }),
    createAgent: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(CreateAgentPayload, payload, "create_agent")
        const client = yield* clientEffect
        return yield* settle(client.directory.createAgent({ payload: body }), payload.requestId, "create_agent")
      }),
    listAgents: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(ListAgentsPayload, payload, "list_agents")
        const client = yield* clientEffect
        return yield* settle(client.directory.listAgents({ payload: body }), payload.requestId, "list_agents")
      }),
    rotateToken: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(RotateTokenPayload, payload, "rotate_token")
        const client = yield* clientEffect
        return yield* settle(client.directory.rotateToken({ payload: body }), payload.requestId, "rotate_token")
      }),
    setWebhook: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(SetWebhookPayload, payload, "register_webhook")
        const client = yield* clientEffect
        return yield* settle(client.directory.setWebhook({ payload: body }), payload.requestId, "register_webhook")
      }),
    putRoom: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(PutRoomPayload, payload, "create_room")
        const client = yield* clientEffect
        return yield* settle(client.directory.putRoom({ payload: body }), payload.requestId, "create_room")
      }),
    deleteRoom: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(DeleteRoomPayload, payload, "create_room")
        const client = yield* clientEffect
        return yield* settle(client.directory.deleteRoom({ payload: body }), payload.requestId, "create_room")
      }),
    listRooms: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(ListRoomsPayload, payload, "list_rooms")
        const client = yield* clientEffect
        return yield* settle(client.directory.listRooms({ payload: body }), payload.requestId, "list_rooms")
      }),
    putMembership: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(PutMembershipPayload, payload, "invite")
        const client = yield* clientEffect
        return yield* settle(client.directory.putMembership({ payload: body }), payload.requestId, "invite")
      }),
    deleteMembership: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(DeleteMembershipPayload, payload, "leave")
        const client = yield* clientEffect
        return yield* settle(client.directory.deleteMembership({ payload: body }), payload.requestId, "leave")
      }),
    getAgent: (payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(GetAgentPayload, payload, "agent.read")
        const client = yield* clientEffect
        return yield* settle(client.directory.getAgent({ payload: body }), payload.requestId, "agent.read")
      }),
  })
})

export const directoryClientLayer = Layer.effect(DirectoryClient, makeDirectoryClient)

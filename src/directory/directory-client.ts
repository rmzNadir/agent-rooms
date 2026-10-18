import { toHttpClient } from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer } from "effect";
import { HttpApiClient } from "effect/http-api";
import { directoryPrepare, directorySettle } from "../api/rpc-client.ts";
import type {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  LeadRequired,
  PersistenceFailed,
  RoomNameTaken,
  Unauthorized,
  Unavailable,
} from "../domain/errors.ts";
import type { IdentityView, RoomSummary } from "../domain/message.ts";
import {
  type AgentList,
  type AgentRecord,
  CreateAgentPayload,
  type CreatedAgent,
  DeleteMembershipPayload,
  DeleteRoomPayload,
  type DirectoryAck,
  DirectoryHttpApi,
  GetAgentPayload,
  ListAgentsPayload,
  ListRoomsPayload,
  PutMembershipPayload,
  PutRoomPayload,
  ResolvePayload,
  type RoomList,
  RotateTokenPayload,
  SetWebhookPayload,
  type WebhookMaterial,
} from "./directory-http-api.ts";
import DirectoryServer from "./directory-server.ts";

export type DirectoryCallError =
  | Unavailable
  | Unauthorized
  | PersistenceFailed
  | InvalidArgument
  | Forbidden
  | AgentNotFound
  | RoomNameTaken
  | LeadRequired;

export interface IDirectoryClient {
  readonly createAgent: (
    payload: CreateAgentPayload
  ) => Effect.Effect<CreatedAgent, DirectoryCallError>;
  readonly deleteMembership: (
    payload: DeleteMembershipPayload
  ) => Effect.Effect<DirectoryAck, DirectoryCallError>;
  readonly deleteRoom: (
    payload: DeleteRoomPayload
  ) => Effect.Effect<DirectoryAck, DirectoryCallError>;
  readonly getAgent: (
    payload: GetAgentPayload
  ) => Effect.Effect<AgentRecord, DirectoryCallError>;
  readonly listAgents: (
    payload: ListAgentsPayload
  ) => Effect.Effect<AgentList, DirectoryCallError>;
  readonly listRooms: (
    payload: ListRoomsPayload
  ) => Effect.Effect<RoomList, DirectoryCallError>;
  readonly putMembership: (
    payload: PutMembershipPayload
  ) => Effect.Effect<DirectoryAck, DirectoryCallError>;
  readonly putRoom: (
    payload: PutRoomPayload
  ) => Effect.Effect<RoomSummary, DirectoryCallError>;
  readonly resolve: (
    payload: ResolvePayload
  ) => Effect.Effect<IdentityView, DirectoryCallError>;
  readonly rotateToken: (
    payload: RotateTokenPayload
  ) => Effect.Effect<CreatedAgent, DirectoryCallError>;
  readonly setWebhook: (
    payload: SetWebhookPayload
  ) => Effect.Effect<WebhookMaterial, DirectoryCallError>;
}

export class DirectoryClient extends Context.Service<
  DirectoryClient,
  IDirectoryClient
>()("@agent-rooms/DirectoryClient") {}

const directoryName = "directory";

const makeDirectoryClient = Effect.gen(function* () {
  const namespace = yield* DirectoryServer;
  const clientEffect = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(DirectoryHttpApi, {
        baseUrl: "http://directory.internal",
        httpClient: toHttpClient(namespace.getByName(directoryName)),
      })
    )
  );

  return DirectoryClient.of({
    createAgent: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          CreateAgentPayload,
          payload,
          "create_agent"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.createAgent({ payload: body }),
          payload.requestId,
          "create_agent"
        );
      }),
    deleteMembership: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          DeleteMembershipPayload,
          payload,
          "leave"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.deleteMembership({ payload: body }),
          payload.requestId,
          "leave"
        );
      }),
    deleteRoom: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          DeleteRoomPayload,
          payload,
          "create_room"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.deleteRoom({ payload: body }),
          payload.requestId,
          "create_room"
        );
      }),
    getAgent: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          GetAgentPayload,
          payload,
          "agent.read"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.getAgent({ payload: body }),
          payload.requestId,
          "agent.read"
        );
      }),
    listAgents: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          ListAgentsPayload,
          payload,
          "list_agents"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.listAgents({ payload: body }),
          payload.requestId,
          "list_agents"
        );
      }),
    listRooms: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          ListRoomsPayload,
          payload,
          "list_rooms"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.listRooms({ payload: body }),
          payload.requestId,
          "list_rooms"
        );
      }),
    putMembership: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          PutMembershipPayload,
          payload,
          "invite"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.putMembership({ payload: body }),
          payload.requestId,
          "invite"
        );
      }),
    putRoom: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          PutRoomPayload,
          payload,
          "create_room"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.putRoom({ payload: body }),
          payload.requestId,
          "create_room"
        );
      }),
    resolve: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          ResolvePayload,
          payload,
          "authenticate"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.resolve({ payload: body }),
          payload.requestId,
          "authenticate"
        );
      }),
    rotateToken: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          RotateTokenPayload,
          payload,
          "rotate_token"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.rotateToken({ payload: body }),
          payload.requestId,
          "rotate_token"
        );
      }),
    setWebhook: (payload) =>
      Effect.gen(function* () {
        const body = yield* directoryPrepare(
          SetWebhookPayload,
          payload,
          "register_webhook"
        );
        const client = yield* clientEffect;
        return yield* directorySettle(
          client.directory.setWebhook({ payload: body }),
          payload.requestId,
          "register_webhook"
        );
      }),
  });
});

export const directoryClientLayer = Layer.effect(
  DirectoryClient,
  makeDirectoryClient
);

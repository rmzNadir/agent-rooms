import { Context, Effect, Layer, Schema } from "effect"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import type { HttpServerResponse } from "effect/http/HttpServerResponse"
import { RoomName, type Actor } from "../domain/actor.ts"
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  LeadRequired,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  PersistenceFailed,
  RoomNameTaken,
  RoomNotFound,
  SelfMentionOnly,
  Unauthorized,
  Unavailable,
  UnknownMention,
} from "../domain/errors.ts"
import { internalRequestId, makeRequestId, makeRoomId, type AgentId, type RequestId, type RoomId } from "../domain/ids.ts"
import {
  IdentityView,
  type MemberView,
  type MessagePage,
  type MessageView,
  type RoomSummary,
  type UnreadView,
} from "../domain/message.ts"
import { DirectoryClient, type DirectoryCallError } from "../directory/directory-client.ts"
import { directoryClientLayer } from "../directory/directory-client.ts"
import {
  type AgentRecord,
  type CreatedAgent,
  WebhookRegistration,
} from "../directory/directory-http-api.ts"
import { InitMember, type Ack, type MemberList, type ThreadList, type TranscriptResult } from "../room/room-http-api.ts"
import { RoomClient, type RoomCallError } from "../room/room-client.ts"
import { roomClientLayer } from "../room/room-client.ts"

const decodeRoomName = Schema.decodeUnknownEffect(RoomName)

export type ChatError =
  | RoomCallError
  | DirectoryCallError
  | MentionRequired
  | UnknownMention
  | SelfMentionOnly
  | NotMember
  | NotInvited
  | NotAuthor
  | Forbidden
  | Unauthorized
  | RoomNotFound
  | MessageNotFound
  | AgentNotFound
  | RoomNameTaken
  | LeadRequired
  | InvalidArgument
  | PersistenceFailed
  | Unavailable

export interface IChat {
  readonly whoami: (actor: Actor) => IdentityView
  readonly listRooms: (actor: Actor, requestId: RequestId) => Effect.Effect<ReadonlyArray<RoomSummary>, ChatError>
  readonly createRoom: (input: {
    readonly actor: Actor
    readonly requestId: RequestId
    readonly name: string
    readonly topic: string
    readonly memberIds: ReadonlyArray<AgentId>
  }) => Effect.Effect<RoomSummary, ChatError>
  readonly invite: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    agentId: AgentId,
  ) => Effect.Effect<MemberView, ChatError>
  readonly join: (actor: Actor, requestId: RequestId, roomId: RoomId) => Effect.Effect<MemberView, ChatError>
  readonly leave: (actor: Actor, requestId: RequestId, roomId: RoomId) => Effect.Effect<Ack, ChatError>
  readonly members: (actor: Actor, requestId: RequestId, roomId: RoomId) => Effect.Effect<MemberList, ChatError>
  readonly postMessage: (input: {
    readonly actor: Actor
    readonly requestId: RequestId
    readonly roomId: RoomId
    readonly body: string
    readonly mentions: ReadonlyArray<string>
    readonly threadRoot: number | null
    readonly replyTo: number | null
  }) => Effect.Effect<MessagePage, ChatError>
  readonly readMessages: (input: {
    readonly actor: Actor
    readonly requestId: RequestId
    readonly roomId: RoomId
    readonly since: number
    readonly limit: number
    readonly thread: number | null
  }) => Effect.Effect<MessagePage, ChatError>
  readonly readTranscript: (input: {
    readonly actor: Actor
    readonly requestId: RequestId
    readonly roomId: RoomId
    readonly since: number
    readonly limit: number
    readonly thread: number | null
    readonly format: "markdown" | "json"
  }) => Effect.Effect<TranscriptResult, ChatError>
  readonly listThreads: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    limit: number,
  ) => Effect.Effect<ThreadList, ChatError>
  readonly searchMessages: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    query: string,
    limit: number,
  ) => Effect.Effect<MessagePage, ChatError>
  readonly waitForMessages: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    since: number,
    limit: number,
    timeoutMs: number,
  ) => Effect.Effect<MessagePage, ChatError>
  readonly getUnread: (actor: Actor, requestId: RequestId, roomId: RoomId) => Effect.Effect<UnreadView, ChatError>
  readonly markRead: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
  ) => Effect.Effect<UnreadView, ChatError>
  readonly react: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
    emoji: string,
  ) => Effect.Effect<MessageView, ChatError>
  readonly editMessage: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
    body: string,
    mentions: ReadonlyArray<string>,
  ) => Effect.Effect<MessageView, ChatError>
  readonly redactMessage: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
  ) => Effect.Effect<MessageView, ChatError>
  readonly registerWebhook: (
    actor: Actor,
    requestId: RequestId,
    webhookUrl: string | null,
  ) => Effect.Effect<WebhookRegistration, ChatError>
  readonly createAgent: (
    actor: Actor,
    requestId: RequestId,
    displayName: string,
    kind: "agent" | "human",
    webhookUrl: string | null,
  ) => Effect.Effect<CreatedAgent, ChatError>
  readonly listAgents: (
    actor: Actor,
    requestId: RequestId,
  ) => Effect.Effect<ReadonlyArray<IdentityView>, ChatError>
  readonly rotateToken: (actor: Actor, requestId: RequestId, agentId: AgentId) => Effect.Effect<CreatedAgent, ChatError>
  readonly resolve: (tokenHash: string, adminTokenHash: string, adminName: string) => Effect.Effect<IdentityView, ChatError>
  readonly forward: (
    roomId: RoomId,
    request: HttpServerRequest,
    requestId: RequestId,
  ) => Effect.Effect<HttpServerResponse, ChatError>
}

export class Chat extends Context.Service<Chat, IChat>()("@agent-rooms/Chat") {}

const badName = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    operation: "create_room",
    message: "name must be a short room name. Correct it and retry.",
    requestId,
    details: { field: "name", constraint: "see the README for the accepted pattern" },
    retryable: false,
  })

const idFailed = (operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    operation,
    message: "A new id could not be minted. Retry the same request.",
    requestId: internalRequestId,
    details: {},
    retryable: true,
  })

export const makeChat = Effect.gen(function* () {
  const rooms = yield* RoomClient
  const directory = yield* DirectoryClient

  return Chat.of({
    whoami: (actor) =>
      new IdentityView({
        agentId: actor.agentId,
        displayName: actor.displayName,
        kind: actor.kind,
        admin: actor.admin,
      }),
    resolve: (tokenHash, adminTokenHash, adminName) =>
      Effect.gen(function* () {
        const requestId = yield* Effect.catchTag(makeRequestId(), "SchemaError", () => Effect.fail(idFailed("authenticate")))
        return yield* directory.resolve({ requestId, tokenHash, adminTokenHash, adminName })
      }),
    listRooms: (actor, requestId) => Effect.map(directory.listRooms({ requestId, actor }), (page) => page.rooms),
    createRoom: (input) =>
      Effect.gen(function* () {
        const name = yield* Effect.catchTag(decodeRoomName(input.name), "SchemaError", () =>
          Effect.fail(badName(input.requestId)),
        )
        const memberIds = input.memberIds.includes(input.actor.agentId)
          ? input.memberIds
          : [input.actor.agentId, ...input.memberIds]
        const records: Array<AgentRecord> = []
        for (const agentId of memberIds) {
          records.push(yield* directory.getAgent({ requestId: input.requestId, agentId }))
        }
        const lead = records.find((record) => record.kind === "agent")
        if (lead === undefined) {
          return yield* new LeadRequired({
            code: "LeadRequired",
            operation: "create_room",
            message: "A room needs at least one agent member to lead it. Add an agent and retry.",
            requestId: input.requestId,
            details: {},
            retryable: false,
          })
        }
        const roomId = yield* Effect.catchTag(makeRoomId(), "SchemaError", () => Effect.fail(idFailed("create_room")))
        const members = records.map(
          (record) =>
            new InitMember({
              agentId: record.agentId,
              displayName: record.displayName,
              kind: record.kind,
              role: record.agentId === lead.agentId ? "lead" : "member",
              webhookUrl: record.webhookUrl,
              webhookSecret: record.webhookSecret,
            }),
        )
        const created = yield* rooms.init(roomId, {
          requestId: input.requestId,
          roomId,
          name,
          topic: input.topic,
          leadId: lead.agentId,
          members,
        })
        yield* directory.putRoom({
          requestId: input.requestId,
          actor: input.actor,
          roomId,
          name,
          topic: input.topic,
          leadId: lead.agentId,
          memberIds: records.map((record) => record.agentId),
        })
        return created
      }),
    invite: (actor, requestId, roomId, agentId) =>
      Effect.gen(function* () {
        const record = yield* directory.getAgent({ requestId, agentId })
        const member = yield* rooms.invite(roomId, {
          requestId,
          actor,
          agentId: record.agentId,
          displayName: record.displayName,
          kind: record.kind,
          webhookUrl: record.webhookUrl,
          webhookSecret: record.webhookSecret,
        })
        yield* directory.putMembership({ requestId, roomId, agentId })
        return member
      }),
    join: (actor, requestId, roomId) =>
      Effect.gen(function* () {
        const record = yield* directory.getAgent({ requestId, agentId: actor.agentId })
        const member = yield* rooms.join(roomId, {
          requestId,
          actor,
          webhookUrl: record.webhookUrl,
          webhookSecret: record.webhookSecret,
        })
        yield* directory.putMembership({ requestId, roomId, agentId: actor.agentId })
        return member
      }),
    leave: (actor, requestId, roomId) =>
      Effect.gen(function* () {
        const ack = yield* rooms.leave(roomId, { requestId, actor })
        yield* directory.deleteMembership({ requestId, roomId, agentId: actor.agentId })
        return ack
      }),
    members: (actor, requestId, roomId) => rooms.members(roomId, { requestId, actor }),
    postMessage: (input) =>
      rooms.postMessage(input.roomId, {
        requestId: input.requestId,
        actor: input.actor,
        body: input.body,
        mentions: input.mentions,
        threadRoot: input.threadRoot,
        replyTo: input.replyTo,
      }),
    readMessages: (input) =>
      Effect.gen(function* () {
        const page = yield* rooms.readMessages(input.roomId, {
          requestId: input.requestId,
          actor: input.actor,
          since: input.since,
          limit: input.limit,
          thread: input.thread,
        })
        yield* Effect.exit(
          directory.putMembership({
            requestId: input.requestId,
            roomId: input.roomId,
            agentId: input.actor.agentId,
          }),
        )
        return page
      }),
    readTranscript: (input) =>
      rooms.transcript(input.roomId, {
        requestId: input.requestId,
        actor: input.actor,
        since: input.since,
        limit: input.limit,
        thread: input.thread,
        format: input.format,
      }),
    listThreads: (actor, requestId, roomId, limit) => rooms.threads(roomId, { requestId, actor, limit }),
    searchMessages: (actor, requestId, roomId, query, limit) =>
      rooms.search(roomId, { requestId, actor, query, limit }),
    waitForMessages: (actor, requestId, roomId, since, limit, timeoutMs) =>
      rooms.wait(roomId, { requestId, actor, since, limit, timeoutMs }),
    getUnread: (actor, requestId, roomId) => rooms.unread(roomId, { requestId, actor }),
    markRead: (actor, requestId, roomId, seq) => rooms.markRead(roomId, { requestId, actor, seq }),
    react: (actor, requestId, roomId, seq, emoji) => rooms.react(roomId, { requestId, actor, seq, emoji }),
    editMessage: (actor, requestId, roomId, seq, body, mentions) =>
      rooms.edit(roomId, { requestId, actor, seq, body, mentions }),
    redactMessage: (actor, requestId, roomId, seq) => rooms.redact(roomId, { requestId, actor, seq }),
    registerWebhook: (actor, requestId, webhookUrl) =>
      Effect.gen(function* () {
        const material = yield* directory.setWebhook({ requestId, actor, webhookUrl })
        for (const roomId of material.roomIds) {
          yield* Effect.catchTag(
            rooms.webhook(roomId, {
              requestId,
              actor,
              webhookUrl: material.webhookUrl,
              webhookSecret: material.webhookSecret,
            }),
            "NotMember",
            () => Effect.void,
          )
        }
        return new WebhookRegistration({
          webhookUrl: material.webhookUrl,
          roomIds: material.roomIds,
        })
      }),
    createAgent: (actor, requestId, displayName, kind, webhookUrl) =>
      directory.createAgent({ requestId, actor, displayName, kind, webhookUrl }),
    listAgents: (actor, requestId) => Effect.map(directory.listAgents({ requestId, actor }), (page) => page.agents),
    rotateToken: (actor, requestId, agentId) => directory.rotateToken({ requestId, actor, agentId }),
    forward: (roomId, request, requestId) => rooms.forward(roomId, request, requestId),
  })
})

export const chatLayerWithoutDependencies = Layer.effect(Chat, makeChat)

export const chatLayer = chatLayerWithoutDependencies.pipe(
  Layer.provide(roomClientLayer),
  Layer.provide(directoryClientLayer),
)

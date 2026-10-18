import { Context, Effect, Layer, Schema } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/http/HttpServerResponse";
import {
  type DirectoryCallError,
  DirectoryClient,
  directoryClientLayer,
} from "../directory/directory-client.ts";
import {
  type AgentRecord,
  type CreatedAgent,
  WebhookRegistration,
} from "../directory/directory-http-api.ts";
import { type Actor, RoomName } from "../domain/actor.ts";
import {
  type AgentNotFound,
  type Forbidden,
  InvalidArgument,
  LeadRequired,
  type MentionRequired,
  type MessageNotFound,
  type NotAuthor,
  type NotInvited,
  type NotMember,
  PersistenceFailed,
  type RoomNameTaken,
  type RoomNotFound,
  type SelfMentionOnly,
  type Unauthorized,
  type Unavailable,
  type UnknownMention,
} from "../domain/errors.ts";
import {
  type AgentId,
  internalRequestId,
  makeRequestId,
  makeRoomId,
  type RequestId,
  type RoomId,
} from "../domain/ids.ts";
import {
  IdentityView,
  type MemberView,
  type MessagePage,
  type MessageView,
  type RoomSummary,
  type UnreadView,
} from "../domain/message.ts";
import {
  type RoomCallError,
  RoomClient,
  roomClientLayer,
} from "../room/room-client.ts";
import {
  type Ack,
  InitMember,
  type MemberList,
  type ThreadList,
  type TranscriptResult,
} from "../room/room-http-api.ts";

const decodeRoomName = Schema.decodeUnknownEffect(RoomName);

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
  | Unavailable;

export interface IChat {
  readonly createAgent: (
    actor: Actor,
    requestId: RequestId,
    displayName: string,
    kind: "agent" | "human",
    webhookUrl: string | null
  ) => Effect.Effect<CreatedAgent, ChatError>;
  readonly createRoom: (input: {
    readonly actor: Actor;
    readonly requestId: RequestId;
    readonly name: string;
    readonly topic: string;
    readonly memberIds: readonly AgentId[];
  }) => Effect.Effect<RoomSummary, ChatError>;
  readonly editMessage: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
    body: string,
    mentions: readonly string[]
  ) => Effect.Effect<MessageView, ChatError>;
  readonly forward: (
    roomId: RoomId,
    request: HttpServerRequest,
    requestId: RequestId
  ) => Effect.Effect<HttpServerResponse, ChatError>;
  readonly getUnread: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId
  ) => Effect.Effect<UnreadView, ChatError>;
  readonly invite: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    agentId: AgentId
  ) => Effect.Effect<MemberView, ChatError>;
  readonly join: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId
  ) => Effect.Effect<MemberView, ChatError>;
  readonly leave: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId
  ) => Effect.Effect<Ack, ChatError>;
  readonly listAgents: (
    actor: Actor,
    requestId: RequestId
  ) => Effect.Effect<readonly IdentityView[], ChatError>;
  readonly listRooms: (
    actor: Actor,
    requestId: RequestId
  ) => Effect.Effect<readonly RoomSummary[], ChatError>;
  readonly listThreads: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    limit: number
  ) => Effect.Effect<ThreadList, ChatError>;
  readonly markRead: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number
  ) => Effect.Effect<UnreadView, ChatError>;
  readonly members: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId
  ) => Effect.Effect<MemberList, ChatError>;
  readonly postMessage: (input: {
    readonly actor: Actor;
    readonly requestId: RequestId;
    readonly roomId: RoomId;
    readonly body: string;
    readonly mentions: readonly string[];
    readonly threadRoot: number | null;
    readonly replyTo: number | null;
  }) => Effect.Effect<MessagePage, ChatError>;
  readonly react: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
    emoji: string
  ) => Effect.Effect<MessageView, ChatError>;
  readonly readMessages: (input: {
    readonly actor: Actor;
    readonly requestId: RequestId;
    readonly roomId: RoomId;
    readonly since: number;
    readonly limit: number;
    readonly thread: number | null;
  }) => Effect.Effect<MessagePage, ChatError>;
  readonly readTranscript: (input: {
    readonly actor: Actor;
    readonly requestId: RequestId;
    readonly roomId: RoomId;
    readonly since: number;
    readonly limit: number;
    readonly thread: number | null;
    readonly format: "markdown" | "json";
  }) => Effect.Effect<TranscriptResult, ChatError>;
  readonly redactMessage: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number
  ) => Effect.Effect<MessageView, ChatError>;
  readonly registerWebhook: (
    actor: Actor,
    requestId: RequestId,
    webhookUrl: string | null
  ) => Effect.Effect<WebhookRegistration, ChatError>;
  readonly resolve: (
    tokenHash: string,
    adminTokenHash: string,
    adminName: string
  ) => Effect.Effect<IdentityView, ChatError>;
  readonly rotateToken: (
    actor: Actor,
    requestId: RequestId,
    agentId: AgentId
  ) => Effect.Effect<CreatedAgent, ChatError>;
  readonly searchMessages: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    query: string,
    limit: number
  ) => Effect.Effect<MessagePage, ChatError>;
  readonly waitForMessages: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    since: number,
    limit: number,
    timeoutMs: number
  ) => Effect.Effect<MessagePage, ChatError>;
  readonly whoami: (actor: Actor) => IdentityView;
}

export class Chat extends Context.Service<Chat, IChat>()("@agent-rooms/Chat") {}

const badName = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: {
      constraint: "see the README for the accepted pattern",
      field: "name",
    },
    message: "name must be a short room name. Correct it and retry.",
    operation: "create_room",
    requestId,
    retryable: false,
  });

const idFailed = (operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    details: {},
    message: "A new id could not be minted. Retry the same request.",
    operation,
    requestId: internalRequestId,
    retryable: true,
  });

const makeChat = Effect.gen(function* () {
  const rooms = yield* RoomClient;
  const directory = yield* DirectoryClient;

  return Chat.of({
    createAgent: (actor, requestId, displayName, kind, webhookUrl) =>
      directory.createAgent({
        actor,
        displayName,
        kind,
        requestId,
        webhookUrl,
      }),
    createRoom: (input) =>
      Effect.gen(function* () {
        const name = yield* Effect.catchTag(
          decodeRoomName(input.name),
          "SchemaError",
          () => Effect.fail(badName(input.requestId))
        );
        const memberIds = input.memberIds.includes(input.actor.agentId)
          ? input.memberIds
          : [input.actor.agentId, ...input.memberIds];
        const records: AgentRecord[] = [];
        for (const agentId of memberIds) {
          records.push(
            yield* directory.getAgent({ agentId, requestId: input.requestId })
          );
        }
        const lead = records.find((record) => record.kind === "agent");
        if (lead === undefined) {
          return yield* new LeadRequired({
            code: "LeadRequired",
            details: {},
            message:
              "A room needs at least one agent member to lead it. Add an agent and retry.",
            operation: "create_room",
            requestId: input.requestId,
            retryable: false,
          });
        }
        const roomId = yield* Effect.catchTag(makeRoomId(), "SchemaError", () =>
          Effect.fail(idFailed("create_room"))
        );
        const members = records.map(
          (record) =>
            new InitMember({
              agentId: record.agentId,
              displayName: record.displayName,
              kind: record.kind,
              role: record.agentId === lead.agentId ? "lead" : "member",
              webhookSecret: record.webhookSecret,
              webhookUrl: record.webhookUrl,
            })
        );
        const created = yield* rooms.init(roomId, {
          leadId: lead.agentId,
          members,
          name,
          requestId: input.requestId,
          roomId,
          topic: input.topic,
        });
        yield* directory.putRoom({
          actor: input.actor,
          leadId: lead.agentId,
          memberIds: records.map((record) => record.agentId),
          name,
          requestId: input.requestId,
          roomId,
          topic: input.topic,
        });
        return created;
      }),
    editMessage: (actor, requestId, roomId, seq, body, mentions) =>
      rooms.edit(roomId, { actor, body, mentions, requestId, seq }),
    forward: (roomId, request, requestId) =>
      rooms.forward(roomId, request, requestId),
    getUnread: (actor, requestId, roomId) =>
      rooms.unread(roomId, { actor, requestId }),
    invite: (actor, requestId, roomId, agentId) =>
      Effect.gen(function* () {
        const record = yield* directory.getAgent({ agentId, requestId });
        const member = yield* rooms.invite(roomId, {
          actor,
          agentId: record.agentId,
          displayName: record.displayName,
          kind: record.kind,
          requestId,
          webhookSecret: record.webhookSecret,
          webhookUrl: record.webhookUrl,
        });
        yield* directory.putMembership({ agentId, requestId, roomId });
        return member;
      }),
    join: (actor, requestId, roomId) =>
      Effect.gen(function* () {
        const record = yield* directory.getAgent({
          agentId: actor.agentId,
          requestId,
        });
        const member = yield* rooms.join(roomId, {
          actor,
          requestId,
          webhookSecret: record.webhookSecret,
          webhookUrl: record.webhookUrl,
        });
        yield* directory.putMembership({
          agentId: actor.agentId,
          requestId,
          roomId,
        });
        return member;
      }),
    leave: (actor, requestId, roomId) =>
      Effect.gen(function* () {
        const ack = yield* rooms.leave(roomId, { actor, requestId });
        yield* directory.deleteMembership({
          agentId: actor.agentId,
          requestId,
          roomId,
        });
        return ack;
      }),
    listAgents: (actor, requestId) =>
      Effect.map(
        directory.listAgents({ actor, requestId }),
        (page) => page.agents
      ),
    listRooms: (actor, requestId) =>
      Effect.map(
        directory.listRooms({ actor, requestId }),
        (page) => page.rooms
      ),
    listThreads: (actor, requestId, roomId, limit) =>
      rooms.threads(roomId, { actor, limit, requestId }),
    markRead: (actor, requestId, roomId, seq) =>
      rooms.markRead(roomId, { actor, requestId, seq }),
    members: (actor, requestId, roomId) =>
      rooms.members(roomId, { actor, requestId }),
    postMessage: (input) =>
      rooms.postMessage(input.roomId, {
        actor: input.actor,
        body: input.body,
        mentions: input.mentions,
        replyTo: input.replyTo,
        requestId: input.requestId,
        threadRoot: input.threadRoot,
      }),
    react: (actor, requestId, roomId, seq, emoji) =>
      rooms.react(roomId, { actor, emoji, requestId, seq }),
    readMessages: (input) =>
      Effect.gen(function* () {
        const page = yield* rooms.readMessages(input.roomId, {
          actor: input.actor,
          limit: input.limit,
          requestId: input.requestId,
          since: input.since,
          thread: input.thread,
        });
        yield* Effect.exit(
          directory.putMembership({
            agentId: input.actor.agentId,
            requestId: input.requestId,
            roomId: input.roomId,
          })
        );
        return page;
      }),
    readTranscript: (input) =>
      rooms.transcript(input.roomId, {
        actor: input.actor,
        format: input.format,
        limit: input.limit,
        requestId: input.requestId,
        since: input.since,
        thread: input.thread,
      }),
    redactMessage: (actor, requestId, roomId, seq) =>
      rooms.redact(roomId, { actor, requestId, seq }),
    registerWebhook: (actor, requestId, webhookUrl) =>
      Effect.gen(function* () {
        const material = yield* directory.setWebhook({
          actor,
          requestId,
          webhookUrl,
        });
        for (const roomId of material.roomIds) {
          yield* Effect.catchTag(
            rooms.webhook(roomId, {
              actor,
              requestId,
              webhookSecret: material.webhookSecret,
              webhookUrl: material.webhookUrl,
            }),
            "NotMember",
            () => Effect.void
          );
        }
        return new WebhookRegistration({
          roomIds: material.roomIds,
          webhookUrl: material.webhookUrl,
        });
      }),
    resolve: (tokenHash, adminTokenHash, adminName) =>
      Effect.gen(function* () {
        const requestId = yield* Effect.catchTag(
          makeRequestId(),
          "SchemaError",
          () => Effect.fail(idFailed("authenticate"))
        );
        return yield* directory.resolve({
          adminName,
          adminTokenHash,
          requestId,
          tokenHash,
        });
      }),
    rotateToken: (actor, requestId, agentId) =>
      directory.rotateToken({ actor, agentId, requestId }),
    searchMessages: (actor, requestId, roomId, query, limit) =>
      rooms.search(roomId, { actor, limit, query, requestId }),
    waitForMessages: (actor, requestId, roomId, since, limit, timeoutMs) =>
      rooms.wait(roomId, { actor, limit, requestId, since, timeoutMs }),
    whoami: (actor) =>
      new IdentityView({
        admin: actor.admin,
        agentId: actor.agentId,
        displayName: actor.displayName,
        kind: actor.kind,
      }),
  });
});

const chatLayerWithoutDependencies = Layer.effect(Chat, makeChat);

export const chatLayer = chatLayerWithoutDependencies.pipe(
  Layer.provide(roomClientLayer),
  Layer.provide(directoryClientLayer)
);

import { Context, Effect, Layer } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Actor } from "../domain/actor.ts";
import type { AgentId, RequestId, RoomId } from "../domain/ids.ts";
import type {
  IdentityView,
  MemberView,
  RoomSummary,
  UnreadView,
} from "../domain/message.ts";
import { client } from "../model/client.ts";
import { Directory } from "../model/directory.ts";
import { Room } from "../model/room.ts";
import { CredentialBook, LegacyImport } from "../runtime/credentials.ts";
import { RoomSockets } from "../runtime/sockets.ts";
import {
  audit,
  type ChatError,
  type ChatHost,
  contextFor,
  type DirectoryClient,
  directoryTarget,
  editVerb,
  failure,
  type RoomClient,
} from "./chat-support.ts";
import { directoryMethods } from "./directory-chat.ts";
import type { messagePage, toMessageView } from "./pages.ts";
import type {
  Ack,
  CreatedAgent,
  MemberList,
  ThreadList,
  TranscriptResult,
  WebhookRegistration,
} from "./records.ts";
import { roomMethods } from "./room-chat.ts";

export type { ChatError } from "./chat-support.ts";

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
  ) => Effect.Effect<ReturnType<typeof toMessageView>, ChatError>;
  readonly forward: (
    roomId: RoomId,
    request: HttpServerRequest.HttpServerRequest,
    requestId: RequestId
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError>;
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
  }) => Effect.Effect<ReturnType<typeof messagePage>, ChatError>;
  readonly react: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    seq: number,
    emoji: string
  ) => Effect.Effect<ReturnType<typeof toMessageView>, ChatError>;
  readonly readMessages: (input: {
    readonly actor: Actor;
    readonly requestId: RequestId;
    readonly roomId: RoomId;
    readonly since: number;
    readonly limit: number;
    readonly thread: number | null;
  }) => Effect.Effect<ReturnType<typeof messagePage>, ChatError>;
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
  ) => Effect.Effect<ReturnType<typeof toMessageView>, ChatError>;
  readonly registerWebhook: (
    actor: Actor,
    requestId: RequestId,
    webhookUrl: string | null
  ) => Effect.Effect<WebhookRegistration, ChatError>;
  readonly releaseRoom: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId
  ) => Effect.Effect<Ack, ChatError>;
  readonly resolve: (
    tokenHash: string,
    adminTokenHash: string,
    adminName: string
  ) => Effect.Effect<IdentityView, ChatError>;
  readonly retireAgent: (
    actor: Actor,
    requestId: RequestId,
    agentId: AgentId
  ) => Effect.Effect<Ack, ChatError>;
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
  ) => Effect.Effect<ReturnType<typeof messagePage>, ChatError>;
  readonly waitForMessages: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId,
    since: number,
    limit: number,
    timeoutMs: number
  ) => Effect.Effect<ReturnType<typeof messagePage>, ChatError>;
  readonly whoami: (actor: Actor) => IdentityView;
}

export class Chat extends Context.Service<Chat, IChat>()("@agent-rooms/Chat") {}

const makeHost = (
  directory: DirectoryClient,
  rooms: RoomClient,
  book: ChatHost["book"],
  legacy: ChatHost["legacy"],
  sockets: ChatHost["sockets"]
): ChatHost => {
  const agents = () => directory.state(directoryTarget);
  const roomState = (roomId: RoomId) =>
    Effect.gen(function* () {
      yield* legacy.room(roomId);
      return yield* rooms.state(roomId);
    });
  const settle: ChatHost["settle"] = (effect, input) =>
    effect.pipe(Effect.catch((error) => failure(error, input)));
  const requireRoom: ChatHost["requireRoom"] = (actor, requestId, roomId) =>
    Effect.gen(function* () {
      const state = yield* roomState(roomId);
      if (!state.open) {
        return yield* failure(
          { _tag: "RoomMissing" },
          contextFor(requestId, roomId, undefined, audit, editVerb)
        );
      }
      const member = state.members.find(
        (item) => item.agentId === actor.agentId && item.joined
      );
      if (member === undefined && !actor.admin) {
        return yield* failure(
          { _tag: "NotMember" },
          contextFor(requestId, roomId, undefined, audit, editVerb)
        );
      }
      return { member, state };
    });
  return {
    agents,
    book,
    directory,
    legacy,
    requireRoom,
    roomState,
    rooms,
    settle,
    sockets,
  };
};

const makeChat = Effect.gen(function* () {
  const directory = yield* client<DirectoryClient>(Directory);
  const rooms = yield* client<RoomClient>(Room);
  const book = yield* CredentialBook;
  const legacy = yield* LegacyImport;
  const sockets = yield* RoomSockets;
  const host = makeHost(directory, rooms, book, legacy, sockets);
  return Chat.of({
    ...directoryMethods(host),
    ...roomMethods(host),
  });
});

export const chatLayer = Layer.effect(Chat, makeChat);

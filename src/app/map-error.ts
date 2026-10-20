import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  PersistenceFailed,
  RoomNameTaken,
  RoomNotFound,
  SelfMentionOnly,
  UnknownMention,
} from "../domain/errors.ts";
import type { AgentId, RequestId, RoomId } from "../domain/ids.ts";

export interface ErrorContext {
  readonly agentId: AgentId | undefined;
  readonly operation: string;
  readonly requestId: RequestId;
  readonly roomId: RoomId | undefined;
  readonly seq: number | undefined;
  readonly verb: "edit" | "redact";
}

interface Tagged {
  readonly _tag: string;
  readonly name?: string;
  readonly token?: string;
}

const roomIdOf = (input: ErrorContext) => {
  if (input.roomId === undefined) {
    return "room_000000000000000000000000" as RoomId;
  }
  return input.roomId;
};

const agentIdOf = (input: ErrorContext) => {
  if (input.agentId === undefined) {
    return "agent_000000000000000000000000" as AgentId;
  }
  return input.agentId;
};

const mention = (input: ErrorContext) =>
  new MentionRequired({
    code: "MentionRequired",
    details: { roomId: roomIdOf(input) },
    message: `Message in room ${roomIdOf(input)} was not posted. Agents must @mention a member, @all, or @human.`,
    operation: "post_message",
    requestId: input.requestId,
    retryable: false,
  });

const unknown = (error: Tagged, input: ErrorContext) =>
  new UnknownMention({
    code: "UnknownMention",
    details: { roomId: roomIdOf(input), token: error.token ?? "" },
    message: `@${error.token ?? ""} is not a member of room ${roomIdOf(input)}. Use a display name, @all, or @human.`,
    operation: "post_message",
    requestId: input.requestId,
    retryable: false,
  });

const self = (input: ErrorContext) =>
  new SelfMentionOnly({
    code: "SelfMentionOnly",
    details: { roomId: roomIdOf(input) },
    message: `Message in room ${roomIdOf(input)} only mentioned you. Mention someone else; posts do not wake their author.`,
    operation: "post_message",
    requestId: input.requestId,
    retryable: false,
  });

export const shownSeq = (input: { readonly seq?: number | undefined }) =>
  input.seq ?? 0;

const missingMessage = (input: ErrorContext) =>
  new MessageNotFound({
    code: "MessageNotFound",
    details: { roomId: roomIdOf(input), seq: shownSeq(input) },
    message: `Message ${shownSeq(input)} was not found in room ${roomIdOf(input)}.`,
    operation: "message.read",
    requestId: input.requestId,
    retryable: false,
  });

const author = (input: ErrorContext) =>
  new NotAuthor({
    code: "NotAuthor",
    details: { roomId: roomIdOf(input), seq: shownSeq(input) },
    message: `Message ${shownSeq(input)} belongs to someone else. You can ${input.verb} only your own messages.`,
    operation: "message.mutate",
    requestId: input.requestId,
    retryable: false,
  });

const member = (input: ErrorContext) =>
  new NotMember({
    code: "NotMember",
    details: { roomId: roomIdOf(input) },
    message: `You are not a member of room ${roomIdOf(input)}. Ask a member to invite you, then join.`,
    operation: "room.access",
    requestId: input.requestId,
    retryable: false,
  });

const invited = (input: ErrorContext) =>
  new NotInvited({
    code: "NotInvited",
    details: { roomId: roomIdOf(input) },
    message: `You are not invited to room ${roomIdOf(input)}. Ask a member to invite you.`,
    operation: "join",
    requestId: input.requestId,
    retryable: false,
  });

const missingRoom = (input: ErrorContext) =>
  new RoomNotFound({
    code: "RoomNotFound",
    details: { roomId: roomIdOf(input) },
    message: `Room ${roomIdOf(input)} was not found. Check the id from list_rooms and try again.`,
    operation: "room.read",
    requestId: input.requestId,
    retryable: false,
  });

const only = (input: ErrorContext) =>
  new Forbidden({
    code: "Forbidden",
    details: {},
    message: `You are the only member of room ${roomIdOf(input)}. Invite someone else before leaving.`,
    operation: "leave",
    requestId: input.requestId,
    retryable: false,
  });

const missingAgent = (input: ErrorContext) =>
  new AgentNotFound({
    code: "AgentNotFound",
    details: { agentId: agentIdOf(input) },
    message: `Agent ${agentIdOf(input)} was not found. Check the id and retry.`,
    operation: "agent.read",
    requestId: input.requestId,
    retryable: false,
  });

export const takenName = (name: string | undefined) => name ?? "";

const taken = (error: Tagged, input: ErrorContext) =>
  new RoomNameTaken({
    code: "RoomNameTaken",
    details: { name: takenName(error.name) },
    message: `A room named ${takenName(error.name)} already exists. Choose a different name.`,
    operation: "create_room",
    requestId: input.requestId,
    retryable: false,
  });

const duplicate = (input: ErrorContext) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint: "must be unique", field: "agentId" },
    message: "That agent is already registered. Choose a different id.",
    operation: "create_agent",
    requestId: input.requestId,
    retryable: false,
  });

const persisted = (input: ErrorContext, operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    details: {},
    message: "The room could not save that change. Retry the same request.",
    operation,
    requestId: input.requestId,
    retryable: true,
  });

const builders = {
  AgentAlreadyRegistered: (_error: Tagged, input: ErrorContext) =>
    duplicate(input),
  AgentMissing: (_error: Tagged, input: ErrorContext) => missingAgent(input),
  AlreadyOpen: (_error: Tagged, input: ErrorContext) =>
    persisted(input, "create_room"),
  MentionRequired: (_error: Tagged, input: ErrorContext) => mention(input),
  MessageNotFound: (_error: Tagged, input: ErrorContext) =>
    missingMessage(input),
  NotAuthor: (_error: Tagged, input: ErrorContext) => author(input),
  NotInvited: (_error: Tagged, input: ErrorContext) => invited(input),
  NotMember: (_error: Tagged, input: ErrorContext) => member(input),
  OnlyMember: (_error: Tagged, input: ErrorContext) => only(input),
  RoomMissing: (_error: Tagged, input: ErrorContext) => missingRoom(input),
  RoomNameTaken: (error: Tagged, input: ErrorContext) => taken(error, input),
  SelfMentionOnly: (_error: Tagged, input: ErrorContext) => self(input),
  UnknownMention: (error: Tagged, input: ErrorContext) => unknown(error, input),
};

export const mapRejection = (error: Tagged, input: ErrorContext) => {
  const build = builders[error._tag as keyof typeof builders];
  if (build === undefined) {
    return persisted(input, input.operation);
  }
  return build(error, input);
};

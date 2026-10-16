import { Schema } from "effect"
import { AgentId, RequestId, RoomId } from "./ids.ts"

const requestFields = {
  message: Schema.String,
  requestId: RequestId,
}

/**
 * The caller posted as an agent without `@mention`ing a target.
 * Name a member, `@all`, or `@human`, then post again.
 */
export class MentionRequired extends Schema.TaggedError<MentionRequired>()(
  "MentionRequired",
  {
    code: Schema.Literal("MentionRequired"),
    operation: Schema.Literal("post_message"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 },
) {}

/**
 * A mention token does not match `@all`, `@human`, or a member of the room.
 */
export class UnknownMention extends Schema.TaggedError<UnknownMention>()(
  "UnknownMention",
  {
    code: Schema.Literal("UnknownMention"),
    operation: Schema.Literal("post_message"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId, token: Schema.String }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 },
) {}

/**
 * The only mention was the author. Mention someone else; a post never wakes its author.
 */
export class SelfMentionOnly extends Schema.TaggedError<SelfMentionOnly>()(
  "SelfMentionOnly",
  {
    code: Schema.Literal("SelfMentionOnly"),
    operation: Schema.Literal("post_message"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 },
) {}

/** The caller is not a joined member of the room. */
export class NotMember extends Schema.TaggedError<NotMember>()(
  "NotMember",
  {
    code: Schema.Literal("NotMember"),
    operation: Schema.Literal("room.access"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 },
) {}

/** Join only works after an invite. */
export class NotInvited extends Schema.TaggedError<NotInvited>()(
  "NotInvited",
  {
    code: Schema.Literal("NotInvited"),
    operation: Schema.Literal("join"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 },
) {}

/** Edit and redact apply only to the caller's own messages. */
export class NotAuthor extends Schema.TaggedError<NotAuthor>()(
  "NotAuthor",
  {
    code: Schema.Literal("NotAuthor"),
    operation: Schema.Literal("message.mutate"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId, seq: Schema.Number }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 },
) {}

/** The caller is authenticated but not allowed to perform the operation. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    code: Schema.Literal("Forbidden"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 },
) {}

/** The bearer token is missing or does not match an agent. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    code: Schema.Literal("Unauthorized"),
    operation: Schema.Literal("authenticate"),
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 401 },
) {}

/** No room is stored under that id. */
export class RoomNotFound extends Schema.TaggedError<RoomNotFound>()(
  "RoomNotFound",
  {
    code: Schema.Literal("RoomNotFound"),
    operation: Schema.Literal("room.read"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 404 },
) {}

/** No message is stored at that sequence. */
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "MessageNotFound",
  {
    code: Schema.Literal("MessageNotFound"),
    operation: Schema.Literal("message.read"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId, seq: Schema.Number }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 404 },
) {}

/** No agent is stored under that id. */
export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  {
    code: Schema.Literal("AgentNotFound"),
    operation: Schema.Literal("agent.read"),
    ...requestFields,
    details: Schema.Struct({ agentId: AgentId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 404 },
) {}

/** A room with that display name already exists. */
export class RoomNameTaken extends Schema.TaggedError<RoomNameTaken>()(
  "RoomNameTaken",
  {
    code: Schema.Literal("RoomNameTaken"),
    operation: Schema.Literal("create_room"),
    ...requestFields,
    details: Schema.Struct({ name: Schema.String }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 409 },
) {}

/** A room needs at least one agent member to act as lead coordinator. */
export class LeadRequired extends Schema.TaggedError<LeadRequired>()(
  "LeadRequired",
  {
    code: Schema.Literal("LeadRequired"),
    operation: Schema.Literal("create_room"),
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 },
) {}

/** The caller sent a field outside the accepted range. */
export class InvalidArgument extends Schema.TaggedError<InvalidArgument>()(
  "InvalidArgument",
  {
    code: Schema.Literal("InvalidArgument"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({
      field: Schema.String,
      constraint: Schema.String,
    }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 },
) {}

/** The room could not finish a storage operation. The same call is safe to retry. */
export class PersistenceFailed extends Schema.TaggedError<PersistenceFailed>()(
  "PersistenceFailed",
  {
    code: Schema.Literal("PersistenceFailed"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(true),
  },
  { httpApiStatus: 503 },
) {}

/** A downstream call did not complete. Retry the same logical operation. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  {
    code: Schema.Literal("Unavailable"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(true),
  },
  { httpApiStatus: 503 },
) {}

/** Public error envelope returned by MCP and the viewer API. */
export const PublicError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.Unknown,
  requestId: Schema.String,
  retryable: Schema.Boolean,
})

const asDetails = (details: object): unknown => details

/** Map a known tagged error onto the public envelope. */
export const publicErrorBody = (error: {
  readonly code: string
  readonly message: string
  readonly requestId: RequestId
  readonly retryable: boolean
  readonly details: object
}) => ({
  code: error.code,
  message: error.message,
  details: asDetails(error.details),
  requestId: error.requestId,
  retryable: error.retryable,
})

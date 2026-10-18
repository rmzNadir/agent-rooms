import { Schema } from "effect";
import { AgentId, RequestId, RoomId } from "./ids.ts";

const requestFields = {
  message: Schema.String,
  requestId: RequestId,
};

export class MentionRequired extends Schema.TaggedError<MentionRequired>()(
  "MentionRequired",
  {
    code: Schema.Literal("MentionRequired"),
    operation: Schema.Literal("post_message"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 }
) {}

export class UnknownMention extends Schema.TaggedError<UnknownMention>()(
  "UnknownMention",
  {
    code: Schema.Literal("UnknownMention"),
    operation: Schema.Literal("post_message"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId, token: Schema.String }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 }
) {}

export class SelfMentionOnly extends Schema.TaggedError<SelfMentionOnly>()(
  "SelfMentionOnly",
  {
    code: Schema.Literal("SelfMentionOnly"),
    operation: Schema.Literal("post_message"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 }
) {}

export class NotMember extends Schema.TaggedError<NotMember>()(
  "NotMember",
  {
    code: Schema.Literal("NotMember"),
    operation: Schema.Literal("room.access"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 }
) {}

export class NotInvited extends Schema.TaggedError<NotInvited>()(
  "NotInvited",
  {
    code: Schema.Literal("NotInvited"),
    operation: Schema.Literal("join"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 }
) {}

export class NotAuthor extends Schema.TaggedError<NotAuthor>()(
  "NotAuthor",
  {
    code: Schema.Literal("NotAuthor"),
    operation: Schema.Literal("message.mutate"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId, seq: Schema.Number }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 }
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    code: Schema.Literal("Forbidden"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 403 }
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    code: Schema.Literal("Unauthorized"),
    operation: Schema.Literal("authenticate"),
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 401 }
) {}

export class RoomNotFound extends Schema.TaggedError<RoomNotFound>()(
  "RoomNotFound",
  {
    code: Schema.Literal("RoomNotFound"),
    operation: Schema.Literal("room.read"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 404 }
) {}

export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "MessageNotFound",
  {
    code: Schema.Literal("MessageNotFound"),
    operation: Schema.Literal("message.read"),
    ...requestFields,
    details: Schema.Struct({ roomId: RoomId, seq: Schema.Number }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 404 }
) {}

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  {
    code: Schema.Literal("AgentNotFound"),
    operation: Schema.Literal("agent.read"),
    ...requestFields,
    details: Schema.Struct({ agentId: AgentId }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 404 }
) {}

export class RoomNameTaken extends Schema.TaggedError<RoomNameTaken>()(
  "RoomNameTaken",
  {
    code: Schema.Literal("RoomNameTaken"),
    operation: Schema.Literal("create_room"),
    ...requestFields,
    details: Schema.Struct({ name: Schema.String }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 409 }
) {}

export class LeadRequired extends Schema.TaggedError<LeadRequired>()(
  "LeadRequired",
  {
    code: Schema.Literal("LeadRequired"),
    operation: Schema.Literal("create_room"),
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 }
) {}

export class InvalidArgument extends Schema.TaggedError<InvalidArgument>()(
  "InvalidArgument",
  {
    code: Schema.Literal("InvalidArgument"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({
      constraint: Schema.String,
      field: Schema.String,
    }),
    retryable: Schema.Literal(false),
  },
  { httpApiStatus: 400 }
) {}

export class PersistenceFailed extends Schema.TaggedError<PersistenceFailed>()(
  "PersistenceFailed",
  {
    code: Schema.Literal("PersistenceFailed"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(true),
  },
  { httpApiStatus: 503 }
) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  {
    code: Schema.Literal("Unavailable"),
    operation: Schema.String,
    ...requestFields,
    details: Schema.Struct({}),
    retryable: Schema.Literal(true),
  },
  { httpApiStatus: 503 }
) {}

export const publicErrorBody = (error: {
  readonly code: string;
  readonly message: string;
  readonly requestId: RequestId;
  readonly retryable: boolean;
  readonly details: object;
}) => ({
  code: error.code,
  details: error.details,
  message: error.message,
  requestId: error.requestId,
  retryable: error.retryable,
});

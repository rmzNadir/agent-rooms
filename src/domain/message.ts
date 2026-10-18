import { Schema } from "effect";
import { MemberKind } from "./actor.ts";
import { AgentId, RoomId } from "./ids.ts";

export class ReactionView extends Schema.Class<ReactionView>("ReactionView")({
  agentId: AgentId,
  emoji: Schema.String,
}) {}

export class MessageView extends Schema.Class<MessageView>("MessageView")({
  authorId: AgentId,
  authorKind: MemberKind,
  authorName: Schema.String,
  body: Schema.String,
  createdAt: Schema.Number,
  editedAt: Schema.NullOr(Schema.Number),
  id: Schema.String,
  mentions: Schema.Array(Schema.String),
  reactions: Schema.Array(ReactionView),
  redacted: Schema.Boolean,
  replyTo: Schema.NullOr(Schema.Number),
  seq: Schema.Number,
  threadRoot: Schema.NullOr(Schema.Number),
}) {}

export class MessagePage extends Schema.Class<MessagePage>("MessagePage")({
  messages: Schema.Array(MessageView),
  nextCursor: Schema.NullOr(Schema.Number),
}) {}

export class ThreadSummary extends Schema.Class<ThreadSummary>("ThreadSummary")(
  {
    lastSeq: Schema.Number,
    preview: Schema.String,
    replies: Schema.Number,
    rootSeq: Schema.Number,
  }
) {}

export class MemberView extends Schema.Class<MemberView>("MemberView")({
  agentId: AgentId,
  displayName: Schema.String,
  joined: Schema.Boolean,
  kind: MemberKind,
  lastReadSeq: Schema.Number,
  role: Schema.Literals(["lead", "member"]),
}) {}

export class UnreadView extends Schema.Class<UnreadView>("UnreadView")({
  lastReadSeq: Schema.Number,
  latestSeq: Schema.Number,
  roomId: RoomId,
  unread: Schema.Number,
}) {}

export class RoomSummary extends Schema.Class<RoomSummary>("RoomSummary")({
  leadId: AgentId,
  name: Schema.String,
  roomId: RoomId,
  topic: Schema.String,
  youAreLead: Schema.Boolean,
}) {}

export class IdentityView extends Schema.Class<IdentityView>("IdentityView")({
  admin: Schema.Boolean,
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
}) {}

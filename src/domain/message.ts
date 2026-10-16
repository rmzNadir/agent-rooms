import { Schema } from "effect"
import { MemberKind } from "./actor.ts"
import { AgentId, RoomId } from "./ids.ts"

export class ReactionView extends Schema.Class<ReactionView>("ReactionView")({
  emoji: Schema.String,
  agentId: AgentId,
}) {}

export class MessageView extends Schema.Class<MessageView>("MessageView")({
  seq: Schema.Number,
  id: Schema.String,
  authorId: AgentId,
  authorName: Schema.String,
  authorKind: MemberKind,
  body: Schema.String,
  mentions: Schema.Array(Schema.String),
  threadRoot: Schema.NullOr(Schema.Number),
  replyTo: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  editedAt: Schema.NullOr(Schema.Number),
  redacted: Schema.Boolean,
  reactions: Schema.Array(ReactionView),
}) {}

export class MessagePage extends Schema.Class<MessagePage>("MessagePage")({
  messages: Schema.Array(MessageView),
  nextCursor: Schema.NullOr(Schema.Number),
}) {}

export class ThreadSummary extends Schema.Class<ThreadSummary>("ThreadSummary")({
  rootSeq: Schema.Number,
  replies: Schema.Number,
  lastSeq: Schema.Number,
  preview: Schema.String,
}) {}

export class MemberView extends Schema.Class<MemberView>("MemberView")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  role: Schema.Literals(["lead", "member"]),
  joined: Schema.Boolean,
  lastReadSeq: Schema.Number,
}) {}

export class UnreadView extends Schema.Class<UnreadView>("UnreadView")({
  roomId: RoomId,
  lastReadSeq: Schema.Number,
  unread: Schema.Number,
  latestSeq: Schema.Number,
}) {}

export class RoomSummary extends Schema.Class<RoomSummary>("RoomSummary")({
  roomId: RoomId,
  name: Schema.String,
  topic: Schema.String,
  leadId: AgentId,
  youAreLead: Schema.Boolean,
}) {}

export class IdentityView extends Schema.Class<IdentityView>("IdentityView")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  admin: Schema.Boolean,
}) {}

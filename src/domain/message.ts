import { Schema } from "effect"
import { MemberKind } from "./actor.ts"
import { AgentId, RoomId } from "./ids.ts"

/** One reaction on a message. */
export class ReactionView extends Schema.Class<ReactionView>("ReactionView")({
  emoji: Schema.String,
  agentId: AgentId,
}) {}

/** A sequenced room message as returned to MCP clients and the viewer. */
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

/** A page of messages plus the cursor to pass as `since` for the next page. */
export class MessagePage extends Schema.Class<MessagePage>("MessagePage")({
  messages: Schema.Array(MessageView),
  nextCursor: Schema.NullOr(Schema.Number),
}) {}

/** One thread root and how many messages it contains. */
export class ThreadSummary extends Schema.Class<ThreadSummary>("ThreadSummary")({
  rootSeq: Schema.Number,
  replies: Schema.Number,
  lastSeq: Schema.Number,
  preview: Schema.String,
}) {}

/** Joined or invited member of a room. */
export class MemberView extends Schema.Class<MemberView>("MemberView")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  role: Schema.Literals(["lead", "member"]),
  joined: Schema.Boolean,
  lastReadSeq: Schema.Number,
}) {}

/** Unread count since the caller's read cursor. */
export class UnreadView extends Schema.Class<UnreadView>("UnreadView")({
  roomId: RoomId,
  lastReadSeq: Schema.Number,
  unread: Schema.Number,
  latestSeq: Schema.Number,
}) {}

/** Room catalog entry. */
export class RoomSummary extends Schema.Class<RoomSummary>("RoomSummary")({
  roomId: RoomId,
  name: Schema.String,
  topic: Schema.String,
  leadId: AgentId,
  youAreLead: Schema.Boolean,
}) {}

/** Identity returned by `whoami`. */
export class IdentityView extends Schema.Class<IdentityView>("IdentityView")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  admin: Schema.Boolean,
}) {}

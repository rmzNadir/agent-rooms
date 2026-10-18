import { Event } from "alchemy/Domain";
import { Schema } from "effect";
import { MemberKind } from "../domain/actor.ts";
import { AgentId } from "../domain/ids.ts";

const ReactionState = Schema.Struct({
  agentId: AgentId,
  emoji: Schema.String,
});

export const MessageState = Schema.Struct({
  authorId: AgentId,
  authorKind: MemberKind,
  authorName: Schema.String,
  body: Schema.String,
  createdAt: Schema.Number,
  mentions: Schema.Array(Schema.String),
  reactions: Schema.Array(ReactionState),
  redacted: Schema.Boolean,
  replyTo: Schema.NullOr(Schema.Number),
  seq: Schema.Number,
  threadRoot: Schema.NullOr(Schema.Number),
});
export type MessageState = typeof MessageState.Type;

export const MemberState = Schema.Struct({
  agentId: AgentId,
  displayName: Schema.String,
  joined: Schema.Boolean,
  kind: MemberKind,
  lastReadSeq: Schema.Number,
  role: Schema.Literals(["lead", "member"]),
});
export type MemberState = typeof MemberState.Type;

const DeliveryState = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["delivered", "expired"]),
});

export const RoomState = Schema.Struct({
  deliveries: Schema.Array(DeliveryState),
  hopCount: Schema.Number,
  leadId: Schema.NullOr(AgentId),
  members: Schema.Array(MemberState),
  messages: Schema.Array(MessageState),
  name: Schema.String,
  open: Schema.Boolean,
  paused: Schema.Boolean,
  topic: Schema.String,
});
export type RoomState = typeof RoomState.Type;

export const initialRoom: RoomState = {
  deliveries: [],
  hopCount: 0,
  leadId: null,
  members: [],
  messages: [],
  name: "",
  open: false,
  paused: false,
  topic: "",
};

export class RoomOpened extends Event("RoomOpened", {
  leadId: AgentId,
  members: Schema.Array(MemberState),
  name: Schema.String,
  topic: Schema.String,
}) {}

export class MemberInvited extends Event("MemberInvited", {
  member: MemberState,
}) {}

export class MemberJoined extends Event("MemberJoined", {
  agentId: AgentId,
}) {}

export class MemberLeft extends Event("MemberLeft", {
  agentId: AgentId,
}) {}

export class LeadTransferred extends Event("LeadTransferred", {
  agentId: AgentId,
}) {}

export class MessagePosted extends Event("MessagePosted", {
  message: MessageState,
  targets: Schema.Array(AgentId),
}) {}

export class PauseNoticePosted extends Event("PauseNoticePosted", {
  message: MessageState,
}) {}

export class RoomPaused extends Event("RoomPaused") {}
export class RoomResumed extends Event("RoomResumed") {}

export class MessageEdited extends Event("MessageEdited", {
  body: Schema.String,
  mentions: Schema.Array(Schema.String),
  seq: Schema.Number,
}) {}

export class MessageRedacted extends Event("MessageRedacted", {
  seq: Schema.Number,
}) {}

export class MessageReacted extends Event("MessageReacted", {
  added: Schema.Boolean,
  agentId: AgentId,
  emoji: Schema.String,
  seq: Schema.Number,
}) {}

export class ReadAdvanced extends Event("ReadAdvanced", {
  agentId: AgentId,
  seq: Schema.Number,
}) {}

export class WakeDelivered extends Event("WakeDelivered", {
  id: Schema.String,
}) {}

export class WakeExpired extends Event("WakeExpired", {
  id: Schema.String,
}) {}

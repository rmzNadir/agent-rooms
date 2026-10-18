import { Command } from "alchemy/Domain";
import { Schema } from "effect";
import { MemberKind } from "../domain/actor.ts";
import { AgentId, RoomId } from "../domain/ids.ts";
import { LegacyRoomSchema } from "./migrate.ts";
import {
  AlreadyOpen,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  OnlyMember,
  RoomMissing,
  SelfMentionOnly,
  UnknownMention,
} from "./rejections.ts";
import {
  HopRecorded,
  LeadTransferred,
  MemberInvited,
  MemberJoined,
  MemberLeft,
  MemberState,
  MessageEdited,
  MessagePosted,
  MessageReacted,
  MessageRedacted,
  PauseNoticePosted,
  ReadAdvanced,
  RoomOpened,
  RoomPaused,
  RoomResumed,
  WakeDelivered,
  WakeExpired,
} from "./room-shape.ts";

const mentioned = [MentionRequired, UnknownMention, SelfMentionOnly] as const;

export class OpenRoom extends Command("OpenRoom", {
  events: [RoomOpened],
  input: {
    leadId: AgentId,
    members: Schema.Array(MemberState),
    name: Schema.String,
    topic: Schema.String,
  },
  rejects: [AlreadyOpen],
  reply: { name: Schema.String },
  target: RoomId,
}) {}

export class InviteMember extends Command("InviteMember", {
  events: [MemberInvited],
  input: {
    actorAdmin: Schema.Boolean,
    actorId: AgentId,
    member: MemberState,
  },
  rejects: [RoomMissing, NotMember],
  target: RoomId,
}) {}

export class JoinRoom extends Command("JoinRoom", {
  events: [MemberJoined],
  input: { agentId: AgentId },
  rejects: [RoomMissing, NotInvited],
  target: RoomId,
}) {}

export class LeaveRoom extends Command("LeaveRoom", {
  events: [MemberLeft, LeadTransferred],
  input: { agentId: AgentId },
  rejects: [RoomMissing, NotMember, OnlyMember],
  target: RoomId,
}) {}

export class PostMessage extends Command("PostMessage", {
  events: [MessagePosted, PauseNoticePosted, RoomPaused, RoomResumed],
  input: {
    authorId: AgentId,
    authorKind: MemberKind,
    authorName: Schema.String,
    body: Schema.String,
    explicitMentions: Schema.Array(Schema.String),
    replyTo: Schema.NullOr(Schema.Number),
    threadRoot: Schema.NullOr(Schema.Number),
  },
  rejects: [RoomMissing, NotMember, MessageNotFound, ...mentioned],
  reply: { seq: Schema.Number },
  target: RoomId,
}) {}

export class EditMessage extends Command("EditMessage", {
  events: [MessageEdited],
  input: {
    actorId: AgentId,
    authorKind: MemberKind,
    body: Schema.String,
    explicitMentions: Schema.Array(Schema.String),
    seq: Schema.Number,
  },
  rejects: [RoomMissing, NotMember, MessageNotFound, NotAuthor, ...mentioned],
  target: RoomId,
}) {}

export class RedactMessage extends Command("RedactMessage", {
  events: [MessageRedacted],
  input: {
    actorAdmin: Schema.Boolean,
    actorId: AgentId,
    seq: Schema.Number,
  },
  rejects: [RoomMissing, NotMember, MessageNotFound, NotAuthor],
  target: RoomId,
}) {}

export class ReactToMessage extends Command("ReactToMessage", {
  events: [MessageReacted],
  input: {
    actorId: AgentId,
    emoji: Schema.String,
    seq: Schema.Number,
  },
  rejects: [RoomMissing, NotMember, MessageNotFound],
  target: RoomId,
}) {}

export class MarkRead extends Command("MarkRead", {
  events: [ReadAdvanced],
  input: { actorId: AgentId, seq: Schema.Number },
  rejects: [RoomMissing, NotMember],
  target: RoomId,
}) {}

export class RecordImport extends Command("RecordImport", {
  events: [RoomOpened, MessagePosted, RoomPaused, HopRecorded],
  input: { room: LegacyRoomSchema },
  rejects: [],
  target: RoomId,
}) {}

export class RecordDelivery extends Command("RecordDelivery", {
  events: [WakeDelivered],
  input: { id: Schema.String },
  rejects: [],
  target: RoomId,
}) {}

export class ExpireWake extends Command("ExpireWake", {
  events: [WakeExpired],
  input: { id: Schema.String },
  rejects: [],
  target: RoomId,
}) {}

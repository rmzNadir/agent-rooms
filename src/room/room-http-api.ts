import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { Actor, MemberKind } from "../domain/actor.ts"
import {
  Forbidden,
  InvalidArgument,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  PersistenceFailed,
  RoomNotFound,
  SelfMentionOnly,
  UnknownMention,
} from "../domain/errors.ts"
import { AgentId, RequestId, RoomId } from "../domain/ids.ts"
import {
  MemberView,
  MessagePage,
  MessageView,
  RoomSummary,
  ThreadSummary,
  UnreadView,
} from "../domain/message.ts"

const roomFailure = [
  NotMember,
  RoomNotFound,
  InvalidArgument,
  PersistenceFailed,
  Forbidden,
] as const

const postFailure = [
  MentionRequired,
  UnknownMention,
  SelfMentionOnly,
  NotMember,
  RoomNotFound,
  MessageNotFound,
  InvalidArgument,
  PersistenceFailed,
] as const

export class InitMember extends Schema.Class<InitMember>("InitMember")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  role: Schema.Literals(["lead", "member"]),
  webhookUrl: Schema.NullOr(Schema.String),
  webhookSecret: Schema.NullOr(Schema.String),
}) {}

export class InitRoomPayload extends Schema.Class<InitRoomPayload>("InitRoomPayload")({
  requestId: RequestId,
  roomId: RoomId,
  name: Schema.String,
  topic: Schema.String,
  leadId: AgentId,
  members: Schema.Array(InitMember),
}) {}

export class InvitePayload extends Schema.Class<InvitePayload>("InvitePayload")({
  requestId: RequestId,
  actor: Actor,
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  webhookUrl: Schema.NullOr(Schema.String),
  webhookSecret: Schema.NullOr(Schema.String),
}) {}

export class JoinPayload extends Schema.Class<JoinPayload>("JoinPayload")({
  requestId: RequestId,
  actor: Actor,
  webhookUrl: Schema.NullOr(Schema.String),
  webhookSecret: Schema.NullOr(Schema.String),
}) {}

export class LeavePayload extends Schema.Class<LeavePayload>("LeavePayload")({
  requestId: RequestId,
  actor: Actor,
}) {}

export class MembersPayload extends Schema.Class<MembersPayload>("MembersPayload")({
  requestId: RequestId,
  actor: Actor,
}) {}

export class PostPayload extends Schema.Class<PostPayload>("PostPayload")({
  requestId: RequestId,
  actor: Actor,
  body: Schema.String,
  mentions: Schema.Array(Schema.String),
  threadRoot: Schema.NullOr(Schema.Number),
  replyTo: Schema.NullOr(Schema.Number),
}) {}

export class ReadPayload extends Schema.Class<ReadPayload>("ReadPayload")({
  requestId: RequestId,
  actor: Actor,
  since: Schema.Number,
  limit: Schema.Number,
  thread: Schema.NullOr(Schema.Number),
}) {}

export class TranscriptPayload extends Schema.Class<TranscriptPayload>("TranscriptPayload")({
  requestId: RequestId,
  actor: Actor,
  since: Schema.Number,
  limit: Schema.Number,
  thread: Schema.NullOr(Schema.Number),
  format: Schema.Literals(["markdown", "json"]),
}) {}

export class ThreadsPayload extends Schema.Class<ThreadsPayload>("ThreadsPayload")({
  requestId: RequestId,
  actor: Actor,
  limit: Schema.Number,
}) {}

export class SearchPayload extends Schema.Class<SearchPayload>("SearchPayload")({
  requestId: RequestId,
  actor: Actor,
  query: Schema.String,
  limit: Schema.Number,
}) {}

export class WaitPayload extends Schema.Class<WaitPayload>("WaitPayload")({
  requestId: RequestId,
  actor: Actor,
  since: Schema.Number,
  limit: Schema.Number,
  timeoutMs: Schema.Number,
}) {}

export class UnreadPayload extends Schema.Class<UnreadPayload>("UnreadPayload")({
  requestId: RequestId,
  actor: Actor,
}) {}

export class MarkReadPayload extends Schema.Class<MarkReadPayload>("MarkReadPayload")({
  requestId: RequestId,
  actor: Actor,
  seq: Schema.Number,
}) {}

export class ReactPayload extends Schema.Class<ReactPayload>("ReactPayload")({
  requestId: RequestId,
  actor: Actor,
  seq: Schema.Number,
  emoji: Schema.String,
}) {}

export class EditPayload extends Schema.Class<EditPayload>("EditPayload")({
  requestId: RequestId,
  actor: Actor,
  seq: Schema.Number,
  body: Schema.String,
  mentions: Schema.Array(Schema.String),
}) {}

export class RedactPayload extends Schema.Class<RedactPayload>("RedactPayload")({
  requestId: RequestId,
  actor: Actor,
  seq: Schema.Number,
}) {}

export class WebhookPayload extends Schema.Class<WebhookPayload>("WebhookPayload")({
  requestId: RequestId,
  actor: Actor,
  webhookUrl: Schema.NullOr(Schema.String),
  webhookSecret: Schema.NullOr(Schema.String),
}) {}

export class TranscriptResult extends Schema.Class<TranscriptResult>("TranscriptResult")({
  text: Schema.String,
  format: Schema.Literals(["markdown", "json"]),
  nextCursor: Schema.NullOr(Schema.Number),
}) {}

export class MemberList extends Schema.Class<MemberList>("MemberList")({
  members: Schema.Array(MemberView),
}) {}

export class ThreadList extends Schema.Class<ThreadList>("ThreadList")({
  threads: Schema.Array(ThreadSummary),
}) {}

export class Ack extends Schema.Class<Ack>("Ack")({
  ok: Schema.Literal(true),
}) {}

const init = HttpApiEndpoint.post("init", "/v1/init", {
  payload: InitRoomPayload,
  success: RoomSummary,
  error: [RoomNotFound, PersistenceFailed],
})

const invite = HttpApiEndpoint.post("invite", "/v1/invite", {
  payload: InvitePayload,
  success: MemberView,
  error: roomFailure,
})

const join = HttpApiEndpoint.post("join", "/v1/join", {
  payload: JoinPayload,
  success: MemberView,
  error: [NotInvited, RoomNotFound, PersistenceFailed, Forbidden],
})

const leave = HttpApiEndpoint.post("leave", "/v1/leave", {
  payload: LeavePayload,
  success: Ack,
  error: roomFailure,
})

const members = HttpApiEndpoint.post("members", "/v1/members", {
  payload: MembersPayload,
  success: MemberList,
  error: roomFailure,
})

const postMessage = HttpApiEndpoint.post("postMessage", "/v1/messages", {
  payload: PostPayload,
  success: MessagePage,
  error: postFailure,
})

const readMessages = HttpApiEndpoint.post("readMessages", "/v1/messages/read", {
  payload: ReadPayload,
  success: MessagePage,
  error: roomFailure,
})

const transcript = HttpApiEndpoint.post("transcript", "/v1/transcript", {
  payload: TranscriptPayload,
  success: TranscriptResult,
  error: roomFailure,
})

const threads = HttpApiEndpoint.post("threads", "/v1/threads", {
  payload: ThreadsPayload,
  success: ThreadList,
  error: roomFailure,
})

const search = HttpApiEndpoint.post("search", "/v1/search", {
  payload: SearchPayload,
  success: MessagePage,
  error: roomFailure,
})

const wait = HttpApiEndpoint.post("wait", "/v1/wait", {
  payload: WaitPayload,
  success: MessagePage,
  error: roomFailure,
})

const unread = HttpApiEndpoint.post("unread", "/v1/unread", {
  payload: UnreadPayload,
  success: UnreadView,
  error: roomFailure,
})

const markRead = HttpApiEndpoint.post("markRead", "/v1/read", {
  payload: MarkReadPayload,
  success: UnreadView,
  error: roomFailure,
})

const react = HttpApiEndpoint.post("react", "/v1/reactions", {
  payload: ReactPayload,
  success: MessageView,
  error: [...roomFailure, MessageNotFound],
})

const edit = HttpApiEndpoint.post("edit", "/v1/messages/edit", {
  payload: EditPayload,
  success: MessageView,
  error: [...postFailure, NotAuthor, MessageNotFound],
})

const redact = HttpApiEndpoint.post("redact", "/v1/messages/redact", {
  payload: RedactPayload,
  success: MessageView,
  error: [...roomFailure, NotAuthor, MessageNotFound],
})

const webhook = HttpApiEndpoint.post("webhook", "/v1/webhook", {
  payload: WebhookPayload,
  success: Ack,
  error: roomFailure,
})

export class RoomGroup extends HttpApiGroup.make("room")
  .add(init)
  .add(invite)
  .add(join)
  .add(leave)
  .add(members)
  .add(postMessage)
  .add(readMessages)
  .add(transcript)
  .add(threads)
  .add(search)
  .add(wait)
  .add(unread)
  .add(markRead)
  .add(react)
  .add(edit)
  .add(redact)
  .add(webhook) {}

export class RoomHttpApi extends HttpApi.make("RoomHttpApi").add(RoomGroup) {}

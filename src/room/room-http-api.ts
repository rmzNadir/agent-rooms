import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Actor, MemberKind } from "../domain/actor.ts";
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
} from "../domain/errors.ts";
import { AgentId, RequestId, RoomId } from "../domain/ids.ts";
import {
  MemberView,
  MessagePage,
  MessageView,
  RoomSummary,
  ThreadSummary,
  UnreadView,
} from "../domain/message.ts";

const roomFailure = [
  NotMember,
  RoomNotFound,
  InvalidArgument,
  PersistenceFailed,
  Forbidden,
] as const;

const postFailure = [
  MentionRequired,
  UnknownMention,
  SelfMentionOnly,
  NotMember,
  RoomNotFound,
  MessageNotFound,
  InvalidArgument,
  PersistenceFailed,
] as const;

export class InitMember extends Schema.Class<InitMember>("InitMember")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  role: Schema.Literals(["lead", "member"]),
  webhookSecret: Schema.NullOr(Schema.String),
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class InitRoomPayload extends Schema.Class<InitRoomPayload>(
  "InitRoomPayload"
)({
  leadId: AgentId,
  members: Schema.Array(InitMember),
  name: Schema.String,
  requestId: RequestId,
  roomId: RoomId,
  topic: Schema.String,
}) {}

export class InvitePayload extends Schema.Class<InvitePayload>("InvitePayload")(
  {
    actor: Actor,
    agentId: AgentId,
    displayName: Schema.String,
    kind: MemberKind,
    requestId: RequestId,
    webhookSecret: Schema.NullOr(Schema.String),
    webhookUrl: Schema.NullOr(Schema.String),
  }
) {}

export class JoinPayload extends Schema.Class<JoinPayload>("JoinPayload")({
  actor: Actor,
  requestId: RequestId,
  webhookSecret: Schema.NullOr(Schema.String),
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class LeavePayload extends Schema.Class<LeavePayload>("LeavePayload")({
  actor: Actor,
  requestId: RequestId,
}) {}

export class MembersPayload extends Schema.Class<MembersPayload>(
  "MembersPayload"
)({
  actor: Actor,
  requestId: RequestId,
}) {}

export class PostPayload extends Schema.Class<PostPayload>("PostPayload")({
  actor: Actor,
  body: Schema.String,
  mentions: Schema.Array(Schema.String),
  replyTo: Schema.NullOr(Schema.Number),
  requestId: RequestId,
  threadRoot: Schema.NullOr(Schema.Number),
}) {}

export class ReadPayload extends Schema.Class<ReadPayload>("ReadPayload")({
  actor: Actor,
  limit: Schema.Number,
  requestId: RequestId,
  since: Schema.Number,
  thread: Schema.NullOr(Schema.Number),
}) {}

export class TranscriptPayload extends Schema.Class<TranscriptPayload>(
  "TranscriptPayload"
)({
  actor: Actor,
  format: Schema.Literals(["markdown", "json"]),
  limit: Schema.Number,
  requestId: RequestId,
  since: Schema.Number,
  thread: Schema.NullOr(Schema.Number),
}) {}

export class ThreadsPayload extends Schema.Class<ThreadsPayload>(
  "ThreadsPayload"
)({
  actor: Actor,
  limit: Schema.Number,
  requestId: RequestId,
}) {}

export class SearchPayload extends Schema.Class<SearchPayload>("SearchPayload")(
  {
    actor: Actor,
    limit: Schema.Number,
    query: Schema.String,
    requestId: RequestId,
  }
) {}

export class WaitPayload extends Schema.Class<WaitPayload>("WaitPayload")({
  actor: Actor,
  limit: Schema.Number,
  requestId: RequestId,
  since: Schema.Number,
  timeoutMs: Schema.Number,
}) {}

export class UnreadPayload extends Schema.Class<UnreadPayload>("UnreadPayload")(
  {
    actor: Actor,
    requestId: RequestId,
  }
) {}

export class MarkReadPayload extends Schema.Class<MarkReadPayload>(
  "MarkReadPayload"
)({
  actor: Actor,
  requestId: RequestId,
  seq: Schema.Number,
}) {}

export class ReactPayload extends Schema.Class<ReactPayload>("ReactPayload")({
  actor: Actor,
  emoji: Schema.String,
  requestId: RequestId,
  seq: Schema.Number,
}) {}

export class EditPayload extends Schema.Class<EditPayload>("EditPayload")({
  actor: Actor,
  body: Schema.String,
  mentions: Schema.Array(Schema.String),
  requestId: RequestId,
  seq: Schema.Number,
}) {}

export class RedactPayload extends Schema.Class<RedactPayload>("RedactPayload")(
  {
    actor: Actor,
    requestId: RequestId,
    seq: Schema.Number,
  }
) {}

export class WebhookPayload extends Schema.Class<WebhookPayload>(
  "WebhookPayload"
)({
  actor: Actor,
  requestId: RequestId,
  webhookSecret: Schema.NullOr(Schema.String),
  webhookUrl: Schema.NullOr(Schema.String),
}) {}

export class TranscriptResult extends Schema.Class<TranscriptResult>(
  "TranscriptResult"
)({
  format: Schema.Literals(["markdown", "json"]),
  nextCursor: Schema.NullOr(Schema.Number),
  text: Schema.String,
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
  error: [RoomNotFound, PersistenceFailed],
  payload: InitRoomPayload,
  success: RoomSummary,
});

const invite = HttpApiEndpoint.post("invite", "/v1/invite", {
  error: roomFailure,
  payload: InvitePayload,
  success: MemberView,
});

const join = HttpApiEndpoint.post("join", "/v1/join", {
  error: [NotInvited, RoomNotFound, PersistenceFailed, Forbidden],
  payload: JoinPayload,
  success: MemberView,
});

const leave = HttpApiEndpoint.post("leave", "/v1/leave", {
  error: roomFailure,
  payload: LeavePayload,
  success: Ack,
});

const members = HttpApiEndpoint.post("members", "/v1/members", {
  error: roomFailure,
  payload: MembersPayload,
  success: MemberList,
});

const postMessage = HttpApiEndpoint.post("postMessage", "/v1/messages", {
  error: postFailure,
  payload: PostPayload,
  success: MessagePage,
});

const readMessages = HttpApiEndpoint.post("readMessages", "/v1/messages/read", {
  error: roomFailure,
  payload: ReadPayload,
  success: MessagePage,
});

const transcript = HttpApiEndpoint.post("transcript", "/v1/transcript", {
  error: roomFailure,
  payload: TranscriptPayload,
  success: TranscriptResult,
});

const threads = HttpApiEndpoint.post("threads", "/v1/threads", {
  error: roomFailure,
  payload: ThreadsPayload,
  success: ThreadList,
});

const search = HttpApiEndpoint.post("search", "/v1/search", {
  error: roomFailure,
  payload: SearchPayload,
  success: MessagePage,
});

const wait = HttpApiEndpoint.post("wait", "/v1/wait", {
  error: roomFailure,
  payload: WaitPayload,
  success: MessagePage,
});

const unread = HttpApiEndpoint.post("unread", "/v1/unread", {
  error: roomFailure,
  payload: UnreadPayload,
  success: UnreadView,
});

const markRead = HttpApiEndpoint.post("markRead", "/v1/read", {
  error: roomFailure,
  payload: MarkReadPayload,
  success: UnreadView,
});

const react = HttpApiEndpoint.post("react", "/v1/reactions", {
  error: [...roomFailure, MessageNotFound],
  payload: ReactPayload,
  success: MessageView,
});

const edit = HttpApiEndpoint.post("edit", "/v1/messages/edit", {
  error: [...postFailure, NotAuthor, MessageNotFound],
  payload: EditPayload,
  success: MessageView,
});

const redact = HttpApiEndpoint.post("redact", "/v1/messages/redact", {
  error: [...roomFailure, NotAuthor, MessageNotFound],
  payload: RedactPayload,
  success: MessageView,
});

const webhook = HttpApiEndpoint.post("webhook", "/v1/webhook", {
  error: roomFailure,
  payload: WebhookPayload,
  success: Ack,
});

class RoomGroup extends HttpApiGroup.make("room")
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

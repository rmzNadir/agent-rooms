import { Schema } from "effect";
import { RoomId } from "../domain/ids.ts";
import { IdentityView, MemberView, ThreadSummary } from "../domain/message.ts";

export class CreatedAgent extends Schema.Class<CreatedAgent>("CreatedAgent")({
  agent: IdentityView,
  token: Schema.String,
  webhookSecret: Schema.String,
}) {}

export class WebhookRegistration extends Schema.Class<WebhookRegistration>(
  "WebhookRegistration"
)({
  roomIds: Schema.Array(RoomId),
  webhookUrl: Schema.NullOr(Schema.String),
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

export class TranscriptResult extends Schema.Class<TranscriptResult>(
  "TranscriptResult"
)({
  format: Schema.Literals(["markdown", "json"]),
  nextCursor: Schema.NullOr(Schema.Number),
  text: Schema.String,
}) {}

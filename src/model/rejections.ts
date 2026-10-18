import { Rejection } from "alchemy/Domain";
import { Schema } from "effect";

export class AlreadyOpen extends Rejection("AlreadyOpen") {}
export class RoomMissing extends Rejection("RoomMissing") {}
export class NotMember extends Rejection("NotMember") {}
export class NotInvited extends Rejection("NotInvited") {}
export class OnlyMember extends Rejection("OnlyMember") {}
export class MentionRequired extends Rejection("MentionRequired") {}
export class UnknownMention extends Rejection("UnknownMention", {
  token: Schema.String,
}) {}
export class SelfMentionOnly extends Rejection("SelfMentionOnly") {}
export class NotAuthor extends Rejection("NotAuthor") {}
export class MessageNotFound extends Rejection("MessageNotFound") {}
export class AgentAlreadyRegistered extends Rejection(
  "AgentAlreadyRegistered"
) {}
export class AgentMissing extends Rejection("AgentMissing") {}
export class RoomNameTaken extends Rejection("RoomNameTaken", {
  name: Schema.String,
}) {}

import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import type { ChatError } from "../app/chat.ts"
import { publicErrorBody } from "../domain/errors.ts"

export const json = (status: number, body: unknown) =>
  Effect.catchTag(HttpServerResponse.json(body, { status }), "HttpBodyError", () =>
    Effect.die("The response could not be encoded."),
  )

const statusFor = (error: ChatError): number => {
  switch (error._tag) {
    case "MentionRequired":
    case "UnknownMention":
    case "SelfMentionOnly":
    case "LeadRequired":
    case "InvalidArgument":
      return 400
    case "Unauthorized":
      return 401
    case "NotMember":
    case "NotInvited":
    case "NotAuthor":
    case "Forbidden":
      return 403
    case "RoomNotFound":
    case "MessageNotFound":
    case "AgentNotFound":
      return 404
    case "RoomNameTaken":
      return 409
    case "PersistenceFailed":
    case "Unavailable":
      return 503
  }
}

export const errorResponse = (error: ChatError) => json(statusFor(error), publicErrorBody(error))

export const finish = <A, R>(effect: Effect.Effect<A, ChatError, R>) =>
  Effect.catchTags(Effect.flatMap(effect, (value) => json(200, value)), {
    MentionRequired: errorResponse,
    UnknownMention: errorResponse,
    SelfMentionOnly: errorResponse,
    NotMember: errorResponse,
    NotInvited: errorResponse,
    NotAuthor: errorResponse,
    Forbidden: errorResponse,
    Unauthorized: errorResponse,
    RoomNotFound: errorResponse,
    MessageNotFound: errorResponse,
    AgentNotFound: errorResponse,
    RoomNameTaken: errorResponse,
    LeadRequired: errorResponse,
    InvalidArgument: errorResponse,
    PersistenceFailed: errorResponse,
    Unavailable: errorResponse,
  })

export const finishResponse = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError, R>) =>
  Effect.catchTags(effect, {
    MentionRequired: errorResponse,
    UnknownMention: errorResponse,
    SelfMentionOnly: errorResponse,
    NotMember: errorResponse,
    NotInvited: errorResponse,
    NotAuthor: errorResponse,
    Forbidden: errorResponse,
    Unauthorized: errorResponse,
    RoomNotFound: errorResponse,
    MessageNotFound: errorResponse,
    AgentNotFound: errorResponse,
    RoomNameTaken: errorResponse,
    LeadRequired: errorResponse,
    InvalidArgument: errorResponse,
    PersistenceFailed: errorResponse,
    Unavailable: errorResponse,
  })

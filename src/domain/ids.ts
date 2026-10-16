import { Effect, Schema } from "effect"

/**
 * Canonical Room Durable Object key. Never a display name.
 */
export const RoomId = Schema.String.check(Schema.isPattern(/^room_[0-9a-f]{24}$/)).pipe(
  Schema.brand("RoomId"),
)
export type RoomId = typeof RoomId.Type

/**
 * Stable agent or human identity.
 */
export const AgentId = Schema.String.check(Schema.isPattern(/^agent_[0-9a-f]{24}$/)).pipe(
  Schema.brand("AgentId"),
)
export type AgentId = typeof AgentId.Type

/**
 * Public correlation id for one MCP or HTTP call.
 */
export const RequestId = Schema.String.check(Schema.isPattern(/^req_[0-9a-f]{24}$/)).pipe(
  Schema.brand("RequestId"),
)
export type RequestId = typeof RequestId.Type

const decodeRoomId = Schema.decodeUnknownEffect(RoomId)
const decodeAgentId = Schema.decodeUnknownEffect(AgentId)
const decodeRequestId = Schema.decodeUnknownEffect(RequestId)

/**
 * Reserved author of room notices such as the hop-limit pause.
 * Not a member and never a wake target.
 */
export const systemAgentId: AgentId = Schema.decodeUnknownSync(AgentId)(
  "agent_000000000000000000000001",
)

/**
 * Request id for work that has no caller: schema migration, wake delivery, and
 * responses that fail before a request id can be minted.
 */
export const internalRequestId: RequestId = Schema.decodeUnknownSync(RequestId)(
  "req_000000000000000000000001",
)

const randomHex = (bytes: number) =>
  Effect.sync(() => {
    const buffer = new Uint8Array(bytes)
    crypto.getRandomValues(buffer)
    return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("")
  })

/** Mint a new Room id. */
export const makeRoomId = Effect.fn("Id.makeRoomId")(function* () {
  return yield* decodeRoomId(`room_${yield* randomHex(12)}`)
})

/** Mint a new agent id. */
export const makeAgentId = Effect.fn("Id.makeAgentId")(function* () {
  return yield* decodeAgentId(`agent_${yield* randomHex(12)}`)
})

/** Mint a request id for a public error envelope. */
export const makeRequestId = Effect.fn("Id.makeRequestId")(function* () {
  return yield* decodeRequestId(`req_${yield* randomHex(12)}`)
})

import { Effect, Schema } from "effect";

export const RoomId = Schema.String.check(
  Schema.isPattern(/^room_[0-9a-f]{24}$/)
).pipe(Schema.brand("RoomId"));
export type RoomId = typeof RoomId.Type;

export const AgentId = Schema.String.check(
  Schema.isPattern(/^agent_[0-9a-f]{24}$/)
).pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

export const RequestId = Schema.String.check(
  Schema.isPattern(/^req_[0-9a-f]{24}$/)
).pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;

const decodeRoomId = Schema.decodeUnknownEffect(RoomId);
const decodeAgentId = Schema.decodeUnknownEffect(AgentId);
const decodeRequestId = Schema.decodeUnknownEffect(RequestId);

export const systemAgentId: AgentId = Schema.decodeUnknownSync(AgentId)(
  "agent_000000000000000000000001"
);

export const internalRequestId: RequestId = Schema.decodeUnknownSync(RequestId)(
  "req_000000000000000000000001"
);

const randomHex = (bytes: number) =>
  Effect.sync(() => {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return [...buffer]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  });

export const makeRoomId = Effect.fn("Id.makeRoomId")(function* () {
  return yield* decodeRoomId(`room_${yield* randomHex(12)}`);
});

export const makeAgentId = Effect.fn("Id.makeAgentId")(function* () {
  return yield* decodeAgentId(`agent_${yield* randomHex(12)}`);
});

export const makeRequestId = Effect.fn("Id.makeRequestId")(function* () {
  return yield* decodeRequestId(`req_${yield* randomHex(12)}`);
});

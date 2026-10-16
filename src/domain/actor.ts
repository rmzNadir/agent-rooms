import { Schema } from "effect"
import { AgentId } from "./ids.ts"

/** Agent or human. The bootstrap admin is a human with `admin: true`. */
export const MemberKind = Schema.Literals(["agent", "human"])
export type MemberKind = typeof MemberKind.Type

/**
 * Authenticated caller. Resolved from a bearer token before any room call.
 */
export class Actor extends Schema.Class<Actor>("Actor")({
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  admin: Schema.Boolean,
}) {}

/** Display names are mention tokens: `@` plus this value. */
export const DisplayName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
)
export type DisplayName = typeof DisplayName.Type

/** Room display name. The Durable Object is still keyed by `RoomId`. */
export const RoomName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,78}$/),
)
export type RoomName = typeof RoomName.Type

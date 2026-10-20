import { Schema } from "effect";
import { AgentId } from "./ids.ts";

export const MemberKind = Schema.Literals(["agent", "human"]);
export type MemberKind = typeof MemberKind.Type;

export class Actor extends Schema.Class<Actor>("Actor")({
  admin: Schema.Boolean,
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
}) {}

export const DisplayName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/)
);
export type DisplayName = typeof DisplayName.Type;

export const RoomName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,78}$/)
);
export type RoomName = typeof RoomName.Type;

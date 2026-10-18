import { Schema } from "effect";
import { AgentId } from "../src/domain/ids.ts";
import type { MemberState, MessageState } from "../src/model/room-shape.ts";
import { initialRoom } from "../src/model/room-shape.ts";

export const agent = (value: string) =>
  Schema.decodeUnknownSync(AgentId)(value);

export const leadId = agent("agent_bbbbbbbbbbbbbbbbbbbbbbbb");
export const samId = agent("agent_cccccccccccccccccccccccc");
export const humanId = agent("agent_dddddddddddddddddddddddd");

export const member = (
  agentId: typeof leadId,
  displayName: string,
  kind: "agent" | "human",
  role: "lead" | "member",
  joined = true
): MemberState => ({
  agentId,
  displayName,
  joined,
  kind,
  lastReadSeq: 0,
  role,
});

export const lead = member(leadId, "Lead", "agent", "lead");
export const sam = member(samId, "Sam", "agent", "member", false);
export const human = member(humanId, "Nadir", "human", "member");

export const message = (
  seq: number,
  authorId: typeof leadId,
  body: string
): MessageState => ({
  authorId,
  authorKind: "agent",
  authorName: "Lead",
  body,
  createdAt: 1,
  mentions: [],
  reactions: [],
  redacted: false,
  replyTo: null,
  seq,
  threadRoot: null,
});

export const openRoom = {
  ...initialRoom,
  leadId,
  members: [lead, sam, human],
  name: "general",
  open: true,
};

interface Fielded {
  readonly events: readonly { readonly tag: string }[];
  readonly fields: object;
  readonly rejects: readonly { readonly tag: string }[];
}

export const fielded = (value: object) => value as Fielded;

export const keys = (value: object) =>
  Object.keys(fielded(value).fields)
    .sort((left, right) => (left < right ? -1 : 1))
    .join(",");

export const tagOf = (value: object | readonly object[]) =>
  Array.isArray(value) ? "" : (value as { readonly _tag: string })._tag;

export const named = (value: object) =>
  value as {
    readonly aggregateName: string;
    readonly key: string;
    readonly modelName: string;
    readonly ops: {
      readonly deliver: { readonly args: object; readonly success: object };
    };
    readonly policyName: string;
    readonly projectionName: string;
    readonly systemName: string;
  };

export const tags = (value: object, key: "events" | "rejects") =>
  fielded(value)[key].map((item) => item.tag);

import type { AgentId } from "../domain/ids.ts";
import type { MemberState, MessageState, RoomState } from "./room-shape.ts";

const mapMembers = (
  state: RoomState,
  agentId: AgentId,
  change: (member: MemberState) => MemberState
): RoomState => ({
  ...state,
  members: state.members.map((member) =>
    member.agentId === agentId ? change(member) : member
  ),
});

const mapMessage = (
  state: RoomState,
  seq: number,
  change: (message: MessageState) => MessageState
): RoomState => ({
  ...state,
  messages: state.messages.map((message) =>
    message.seq === seq ? change(message) : message
  ),
});

export const applyOpened = (
  state: RoomState,
  event: {
    readonly leadId: AgentId;
    readonly members: readonly MemberState[];
    readonly name: string;
    readonly topic: string;
  }
): RoomState => ({
  ...state,
  hopCount: 0,
  leadId: event.leadId,
  members: [...event.members],
  name: event.name,
  open: true,
  paused: false,
  topic: event.topic,
});

export const applyInvited = (
  state: RoomState,
  member: MemberState
): RoomState => ({
  ...state,
  members: [...state.members, member],
});

export const applyJoined = (state: RoomState, agentId: AgentId): RoomState =>
  mapMembers(state, agentId, (member) => ({ ...member, joined: true }));

export const applyLeft = (state: RoomState, agentId: AgentId): RoomState => ({
  ...state,
  members: state.members.filter((member) => member.agentId !== agentId),
});

export const applyLead = (state: RoomState, agentId: AgentId): RoomState => ({
  ...mapMembers(state, agentId, (member) => ({ ...member, role: "lead" })),
  leadId: agentId,
});

const nextHop = (
  hopCount: number,
  event: {
    readonly message: MessageState;
    readonly targets: readonly AgentId[];
  }
) => {
  if (event.message.authorKind === "human") {
    return 0;
  }
  if (event.targets.length > 0) {
    return hopCount + 1;
  }
  return hopCount;
};

export const applyPosted = (
  state: RoomState,
  event: {
    readonly message: MessageState;
    readonly targets: readonly AgentId[];
  }
): RoomState => ({
  ...state,
  hopCount: nextHop(state.hopCount, event),
  messages: [...state.messages, event.message],
});

export const applyNotice = (
  state: RoomState,
  message: MessageState
): RoomState => ({
  ...state,
  messages: [...state.messages, message],
  paused: true,
});

export const applyPaused = (state: RoomState): RoomState => ({
  ...state,
  paused: true,
});

export const applyResumed = (state: RoomState): RoomState => ({
  ...state,
  hopCount: 0,
  paused: false,
});

export const applyEdited = (
  state: RoomState,
  event: {
    readonly body: string;
    readonly mentions: readonly string[];
    readonly seq: number;
  }
): RoomState =>
  mapMessage(state, event.seq, (message) => ({
    ...message,
    body: event.body,
    mentions: [...event.mentions],
  }));

export const applyRedacted = (state: RoomState, seq: number): RoomState =>
  mapMessage(state, seq, (message) => ({
    ...message,
    body: "[redacted]",
    mentions: [],
    reactions: [],
    redacted: true,
  }));

export const applyReacted = (
  state: RoomState,
  event: {
    readonly added: boolean;
    readonly agentId: AgentId;
    readonly emoji: string;
    readonly seq: number;
  }
): RoomState =>
  mapMessage(state, event.seq, (message) => ({
    ...message,
    reactions: event.added
      ? [...message.reactions, { agentId: event.agentId, emoji: event.emoji }]
      : message.reactions.filter(
          (reaction) =>
            reaction.agentId !== event.agentId || reaction.emoji !== event.emoji
        ),
  }));

export const applyRead = (
  state: RoomState,
  event: { readonly agentId: AgentId; readonly seq: number }
): RoomState =>
  mapMembers(state, event.agentId, (member) => ({
    ...member,
    lastReadSeq: event.seq,
  }));

export const applyDelivery = (
  state: RoomState,
  id: string,
  status: "delivered" | "expired"
): RoomState => ({
  ...state,
  deliveries: [...state.deliveries, { id, status }],
});

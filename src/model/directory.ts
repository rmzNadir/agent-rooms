import { Aggregate, Command, Event } from "alchemy/Domain";
import { Schema } from "effect";
import { MemberKind } from "../domain/actor.ts";
import { AgentId, RoomId } from "../domain/ids.ts";
import {
  AgentAlreadyRegistered,
  AgentMissing,
  RoomNameTaken,
} from "./rejections.ts";

const AgentState = Schema.Struct({
  admin: Schema.optional(Schema.Boolean),
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  tokenHash: Schema.String,
});
const RoomListing = Schema.Struct({
  leadId: AgentId,
  name: Schema.String,
  roomId: RoomId,
  topic: Schema.String,
});

const DirectoryState = Schema.Struct({
  agents: Schema.Array(AgentState),
  rooms: Schema.Array(RoomListing),
});
type DirectoryState = typeof DirectoryState.Type;

const initialDirectory: DirectoryState = { agents: [], rooms: [] };

const directoryId = Schema.String;

export class AgentRegistered extends Event("AgentRegistered", {
  agent: AgentState,
}) {}

export class TokenRotated extends Event("TokenRotated", {
  agentId: AgentId,
  tokenHash: Schema.String,
}) {}

export class AgentRetired extends Event("AgentRetired", {
  agentId: AgentId,
}) {}

export class RoomReleased extends Event("RoomReleased", {
  roomId: RoomId,
}) {}

export class RoomReserved extends Event("RoomReserved", {
  leadId: AgentId,
  name: Schema.String,
  roomId: RoomId,
  topic: Schema.String,
}) {}

const ImportedAgent = Schema.Struct({
  admin: Schema.optional(Schema.Boolean),
  agentId: AgentId,
  displayName: Schema.String,
  kind: MemberKind,
  tokenHash: Schema.String,
});

export class RegisterAgent extends Command("RegisterAgent", {
  events: [AgentRegistered],
  input: {
    admin: Schema.optional(Schema.Boolean),
    agentId: AgentId,
    displayName: Schema.String,
    kind: MemberKind,
    tokenHash: Schema.String,
  },
  rejects: [AgentAlreadyRegistered],
  target: directoryId,
}) {}

export class RegisterImported extends Command("RegisterImported", {
  events: [AgentRegistered, RoomReserved],
  input: {
    agents: Schema.Array(ImportedAgent),
    rooms: Schema.Array(RoomListing),
  },
  rejects: [],
  target: directoryId,
}) {}

export class RotateToken extends Command("RotateToken", {
  events: [TokenRotated],
  input: { agentId: AgentId, tokenHash: Schema.String },
  rejects: [AgentMissing],
  target: directoryId,
}) {}

export class RetireAgent extends Command("RetireAgent", {
  events: [AgentRetired],
  input: { agentId: AgentId },
  rejects: [],
  target: directoryId,
}) {}

export class ReleaseRoom extends Command("ReleaseRoom", {
  events: [RoomReleased],
  input: { roomId: RoomId },
  rejects: [],
  target: directoryId,
}) {}

export class ReserveRoom extends Command("ReserveRoom", {
  events: [RoomReserved],
  input: {
    leadId: AgentId,
    memberIds: Schema.Array(AgentId),
    name: Schema.String,
    roomId: RoomId,
    topic: Schema.String,
  },
  rejects: [RoomNameTaken, AgentMissing],
  target: directoryId,
}) {}

type Registered = InstanceType<typeof RegisterAgent>;
type Imported = InstanceType<typeof RegisterImported>;
type Rotated = InstanceType<typeof RotateToken>;
type Released = InstanceType<typeof ReleaseRoom>;
type Retired = InstanceType<typeof RetireAgent>;
type Reserved = InstanceType<typeof ReserveRoom>;

const knownAgent = (state: DirectoryState, agentId: AgentId) =>
  state.agents.some((agent) => agent.agentId === agentId);

const enrolled = (agent: {
  readonly admin?: boolean | undefined;
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly kind: "agent" | "human";
  readonly tokenHash: string;
}) => ({
  agentId: agent.agentId,
  displayName: agent.displayName,
  kind: agent.kind,
  tokenHash: agent.tokenHash,
  ...(agent.admin === true ? { admin: true } : {}),
});

export const Directory = Aggregate("Directory", {
  commands: [
    RegisterAgent,
    RegisterImported,
    ReleaseRoom,
    ReserveRoom,
    RetireAgent,
    RotateToken,
  ],
  decide: {
    RegisterAgent: (state: DirectoryState, command: Registered) =>
      knownAgent(state, command.agentId)
        ? new AgentAlreadyRegistered()
        : [
            new AgentRegistered({
              agent: enrolled(command),
            }),
          ],
    RegisterImported: (state: DirectoryState, command: Imported) => {
      if (state.agents.length > 0) {
        return [];
      }
      return [
        ...command.agents.map(
          (agent) =>
            new AgentRegistered({
              agent: enrolled(agent),
            })
        ),
        ...command.rooms.map(
          (room) =>
            new RoomReserved({
              leadId: room.leadId,
              name: room.name,
              roomId: room.roomId,
              topic: room.topic,
            })
        ),
      ];
    },
    ReleaseRoom: (state: DirectoryState, command: Released) =>
      state.rooms.some((room) => room.roomId === command.roomId)
        ? [new RoomReleased({ roomId: command.roomId })]
        : [],
    ReserveRoom: (state: DirectoryState, command: Reserved) => {
      const missing = command.memberIds.find(
        (agentId) => !knownAgent(state, agentId)
      );
      if (missing !== undefined || !knownAgent(state, command.leadId)) {
        return new AgentMissing();
      }
      const taken = state.rooms.some(
        (room) => room.name === command.name && room.roomId !== command.roomId
      );
      return taken
        ? new RoomNameTaken({ name: command.name })
        : [
            new RoomReserved({
              leadId: command.leadId,
              name: command.name,
              roomId: command.roomId,
              topic: command.topic,
            }),
          ];
    },
    RetireAgent: (state: DirectoryState, command: Retired) =>
      knownAgent(state, command.agentId)
        ? [new AgentRetired({ agentId: command.agentId })]
        : [],
    RotateToken: (state: DirectoryState, command: Rotated) => {
      const current = state.agents.find(
        (agent) => agent.agentId === command.agentId
      );
      if (current === undefined) {
        return new AgentMissing();
      }
      return current.tokenHash === command.tokenHash
        ? []
        : [
            new TokenRotated({
              agentId: command.agentId,
              tokenHash: command.tokenHash,
            }),
          ];
    },
  },
  evolve: {
    AgentRegistered: (
      state: DirectoryState,
      event: { readonly agent: DirectoryState["agents"][number] }
    ) => ({
      agents: [...state.agents, event.agent],
      rooms: state.rooms,
    }),
    AgentRetired: (
      state: DirectoryState,
      event: { readonly agentId: AgentId }
    ) => ({
      agents: state.agents.filter((agent) => agent.agentId !== event.agentId),
      rooms: state.rooms,
    }),
    RoomReleased: (
      state: DirectoryState,
      event: { readonly roomId: RoomId }
    ) => ({
      agents: state.agents,
      rooms: state.rooms.filter((room) => room.roomId !== event.roomId),
    }),
    RoomReserved: (
      state: DirectoryState,
      event: DirectoryState["rooms"][number]
    ) => ({
      agents: state.agents,
      rooms: [
        ...state.rooms.filter((room) => room.roomId !== event.roomId),
        event,
      ],
    }),
    TokenRotated: (
      state: DirectoryState,
      event: { readonly agentId: AgentId; readonly tokenHash: string }
    ) => ({
      agents: state.agents.map((agent) =>
        agent.agentId === event.agentId
          ? { ...agent, tokenHash: event.tokenHash }
          : agent
      ),
      rooms: state.rooms,
    }),
  },
  id: directoryId,
  initial: initialDirectory,
  state: DirectoryState,
});

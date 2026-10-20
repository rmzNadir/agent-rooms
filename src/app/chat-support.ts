import { Effect, Schema } from "effect";
import { type Actor, DisplayName, RoomName } from "../domain/actor.ts";
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  type LeadRequired,
  PersistenceFailed,
  Unauthorized,
  type Unavailable,
} from "../domain/errors.ts";
import {
  type AgentId,
  internalRequestId,
  type RequestId,
  type RoomId,
} from "../domain/ids.ts";
import { MemberView } from "../domain/message.ts";
import type { MemberState, RoomState } from "../model/room-shape.ts";
import type { RoomSocketApi } from "../runtime/sockets.ts";
import { type ErrorContext, mapRejection } from "./map-error.ts";

export type ChatError =
  | ReturnType<typeof mapRejection>
  | LeadRequired
  | Unauthorized
  | Unavailable;

export const directoryTarget = "directory";
export const decodeRoomName = Schema.decodeUnknownEffect(RoomName);
export const decodeDisplayName = Schema.decodeUnknownEffect(DisplayName);

export interface Tagged {
  readonly _tag: string;
  readonly name?: string;
  readonly token?: string;
}

export interface DirectoryAgent {
  readonly admin?: boolean;
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly kind: "agent" | "human";
  readonly tokenHash: string;
}

interface DirectoryRoom {
  readonly leadId: AgentId;
  readonly name: string;
  readonly roomId: RoomId;
  readonly topic: string;
}

interface DirectorySnapshot {
  readonly agents: readonly DirectoryAgent[];
  readonly rooms: readonly DirectoryRoom[];
}

export interface DirectoryClient {
  readonly send: (id: string, command: object) => Effect.Effect<void, Tagged>;
  readonly state: (id: string) => Effect.Effect<DirectorySnapshot>;
}

export interface RoomClient {
  readonly send: (id: string, command: object) => Effect.Effect<void, Tagged>;
  readonly state: (id: string) => Effect.Effect<RoomState>;
}

export interface ChatHost {
  readonly agents: () => Effect.Effect<DirectorySnapshot>;
  readonly book: {
    readonly get: (agentId: string) => Effect.Effect<
      | {
          readonly admin: boolean;
          readonly secret: string;
          readonly url: string | null;
        }
      | undefined
    >;
    readonly put: (
      agentId: string,
      credential: {
        readonly admin: boolean;
        readonly secret: string;
        readonly url: string | null;
      }
    ) => Effect.Effect<void>;
  };
  readonly directory: DirectoryClient;
  readonly legacy: {
    readonly directory: () => Effect.Effect<void>;
    readonly room: (roomId: string) => Effect.Effect<void>;
  };
  readonly requireRoom: (
    actor: Actor,
    requestId: RequestId,
    roomId: RoomId
  ) => Effect.Effect<
    { readonly member: MemberState | undefined; readonly state: RoomState },
    ChatError
  >;
  readonly roomState: (roomId: RoomId) => Effect.Effect<RoomState, ChatError>;
  readonly rooms: RoomClient;
  readonly settle: <A>(
    effect: Effect.Effect<A, Tagged>,
    input: ErrorContext
  ) => Effect.Effect<A, ChatError>;
  readonly sockets: RoomSocketApi;
}

export const audit = "authenticate";
export const editVerb = "edit" as const;

export const failure = (error: Tagged, input: ErrorContext) =>
  Effect.fail(mapRejection(error, input));

export const orSchema = <A, E>(
  effect: Effect.Effect<A, { readonly _tag: "SchemaError" }>,
  failed: Effect.Effect<never, E>
) => effect.pipe(Effect.catchTag("SchemaError", () => failed));

export const contextFor = (
  requestId: RequestId,
  roomId: RoomId | undefined,
  seq: number | undefined,
  operation: string,
  verb: "edit" | "redact",
  agentId?: AgentId
): ErrorContext => ({
  agentId,
  operation,
  requestId,
  roomId,
  seq,
  verb,
});

export const denied = (requestId: RequestId, operation: string) =>
  new Forbidden({
    code: "Forbidden",
    details: {},
    message:
      "That action is limited to the admin human. Use an admin token and retry.",
    operation,
    requestId,
    retryable: false,
  });

export const badName = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: {
      constraint: "see the README for the accepted pattern",
      field: "name",
    },
    message: "name must be a short room name. Correct it and retry.",
    operation: "create_room",
    requestId,
    retryable: false,
  });

export const badDisplay = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: {
      constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}",
      field: "displayName",
    },
    message:
      "Display name must be one mention token, such as ada or coordinator.",
    operation: "create_agent",
    requestId,
    retryable: false,
  });

export const duplicateName = (requestId: RequestId, name: string) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint: "must be unique", field: "displayName" },
    message: `An agent named ${name} already exists. Choose a different display name.`,
    operation: "create_agent",
    requestId,
    retryable: false,
  });

export const idFailed = (operation: string) =>
  new PersistenceFailed({
    code: "PersistenceFailed",
    details: {},
    message: "A new id could not be minted. Retry the same request.",
    operation,
    requestId: internalRequestId,
    retryable: true,
  });

export const createAgentIdFailed = () => Effect.fail(idFailed("create_agent"));
export const createRoomIdFailed = () => Effect.fail(idFailed("create_room"));
export const authenticateIdFailed = () => Effect.fail(idFailed("authenticate"));

export const missingAgent = (requestId: RequestId, agentId: AgentId) =>
  new AgentNotFound({
    code: "AgentNotFound",
    details: { agentId },
    message: `Agent ${agentId} was not found. Check the id and retry.`,
    operation: "agent.read",
    requestId,
    retryable: false,
  });

export const memberView = (member: MemberState) =>
  new MemberView({
    agentId: member.agentId,
    displayName: member.displayName,
    joined: member.joined,
    kind: member.kind,
    lastReadSeq: member.lastReadSeq,
    role: member.role,
  });

export const byText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export const unrecognized = (requestId: RequestId) =>
  new Unauthorized({
    code: "Unauthorized",
    details: {},
    message: "The bearer token was not recognized. Check the token and retry.",
    operation: audit,
    requestId,
    retryable: false,
  });

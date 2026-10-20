import { Effect } from "effect";
import { decideAdmin } from "../domain/admin-auth.ts";
import { InvalidArgument, LeadRequired } from "../domain/errors.ts";
import {
  makeAgentId,
  makeRequestId,
  makeRoomId,
  type RequestId,
  type RoomId,
} from "../domain/ids.ts";
import { IdentityView, RoomSummary } from "../domain/message.ts";
import { hashToken, makeSecret } from "../domain/token.ts";
import {
  RegisterAgent,
  ReleaseRoom,
  ReserveRoom,
  RetireAgent,
  RotateToken,
} from "../model/directory.ts";
import { OpenRoom } from "../model/room-commands.ts";
import type { MemberState } from "../model/room-shape.ts";
import type { IChat } from "./chat.ts";
import {
  audit,
  authenticateIdFailed,
  badDisplay,
  badName,
  byText,
  type ChatHost,
  contextFor,
  createAgentIdFailed,
  createRoomIdFailed,
  type DirectoryAgent,
  decodeDisplayName,
  decodeRoomName,
  denied,
  directoryTarget,
  duplicateName,
  editVerb,
  missingAgent,
  orSchema,
  unrecognized,
} from "./chat-support.ts";
import { webhookOf } from "./limits.ts";
import { Ack, CreatedAgent, WebhookRegistration } from "./records.ts";

const leadRequired = (requestId: RequestId) =>
  new LeadRequired({
    code: "LeadRequired",
    details: {},
    message:
      "A room needs at least one agent member to lead it. Add an agent and retry.",
    operation: "create_room",
    requestId,
    retryable: false,
  });

const badAdminName = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: {
      constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}",
      field: "adminName",
    },
    message:
      "AGENT_ROOMS_ADMIN_NAME must be a single mention token such as human.",
    operation: "authenticate",
    requestId,
    retryable: false,
  });

export const directoryMethods = (
  host: ChatHost
): Pick<
  IChat,
  | "createAgent"
  | "createRoom"
  | "listAgents"
  | "listRooms"
  | "registerWebhook"
  | "releaseRoom"
  | "resolve"
  | "retireAgent"
  | "rotateToken"
> => ({
  createAgent: (actor, requestId, displayName, kind, webhookUrl) =>
    Effect.gen(function* () {
      if (!actor.admin) {
        return yield* Effect.fail(denied(requestId, "create_agent"));
      }
      yield* webhookOf(requestId, "create_agent", webhookUrl);
      const name = yield* decodeDisplayName(displayName).pipe(
        Effect.catchTag("SchemaError", () => Effect.fail(badDisplay(requestId)))
      );
      const state = yield* host.agents();
      if (state.agents.some((agent) => agent.displayName === name)) {
        return yield* Effect.fail(duplicateName(requestId, name));
      }
      const agentId = yield* orSchema(makeAgentId(), createAgentIdFailed());
      const token = yield* makeSecret();
      const tokenHash = yield* hashToken(token);
      const webhookSecret = yield* makeSecret();
      yield* host.settle(
        host.directory.send(
          directoryTarget,
          new RegisterAgent({
            admin: false,
            agentId,
            displayName: name,
            kind,
            tokenHash,
          })
        ),
        contextFor(requestId, undefined, undefined, audit, editVerb, agentId)
      );
      yield* host.book.put(agentId, {
        admin: false,
        secret: webhookSecret,
        url: webhookUrl,
      });
      return new CreatedAgent({
        agent: new IdentityView({
          admin: false,
          agentId,
          displayName: name,
          kind,
        }),
        token,
        webhookSecret,
      });
    }),
  createRoom: (input) =>
    Effect.gen(function* () {
      const name = yield* decodeRoomName(input.name).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(badName(input.requestId))
        )
      );
      const memberIds = input.memberIds.includes(input.actor.agentId)
        ? input.memberIds
        : [input.actor.agentId, ...input.memberIds];
      const state = yield* host.agents();
      const records: DirectoryAgent[] = [];
      for (const agentId of memberIds) {
        const found = state.agents.find((agent) => agent.agentId === agentId);
        if (found === undefined) {
          return yield* Effect.fail(missingAgent(input.requestId, agentId));
        }
        records.push(found);
      }
      const lead = records.find((record) => record.kind === "agent");
      if (lead === undefined) {
        return yield* Effect.fail(leadRequired(input.requestId));
      }
      const roomId = yield* orSchema(makeRoomId(), createRoomIdFailed());
      const members = records.map(
        (record): MemberState => ({
          agentId: record.agentId,
          displayName: record.displayName,
          joined: true,
          kind: record.kind,
          lastReadSeq: 0,
          role: record.agentId === lead.agentId ? "lead" : "member",
        })
      );
      const errorContext = contextFor(
        input.requestId,
        roomId,
        undefined,
        audit,
        editVerb
      );
      yield* host.settle(
        host.directory.send(
          directoryTarget,
          new ReserveRoom({
            leadId: lead.agentId,
            memberIds: records.map((record) => record.agentId),
            name,
            roomId,
            topic: input.topic,
          })
        ),
        errorContext
      );
      yield* host.settle(
        host.rooms.send(
          roomId,
          new OpenRoom({
            leadId: lead.agentId,
            members,
            name,
            topic: input.topic,
          })
        ),
        errorContext
      );
      return new RoomSummary({
        leadId: lead.agentId,
        name,
        roomId,
        topic: input.topic,
        youAreLead: input.actor.agentId === lead.agentId,
      });
    }),
  listAgents: (actor, requestId) =>
    Effect.gen(function* () {
      if (!actor.admin) {
        return yield* Effect.fail(denied(requestId, "list_agents"));
      }
      const state = yield* host.agents();
      return state.agents
        .map(
          (agent) =>
            new IdentityView({
              admin: agent.admin === true,
              agentId: agent.agentId,
              displayName: agent.displayName,
              kind: agent.kind,
            })
        )
        .sort((left, right) => byText(left.displayName, right.displayName));
    }),
  listRooms: (actor, _requestId) =>
    Effect.gen(function* () {
      const state = yield* host.agents();
      const summaries: RoomSummary[] = [];
      for (const room of state.rooms) {
        yield* host.legacy.room(room.roomId);
        const live = yield* host.rooms.state(room.roomId);
        const leadId = live.leadId ?? room.leadId;
        const visible =
          actor.admin ||
          live.members.some((member) => member.agentId === actor.agentId);
        if (!visible) {
          continue;
        }
        summaries.push(
          new RoomSummary({
            leadId,
            name: live.name,
            roomId: room.roomId,
            topic: live.topic,
            youAreLead: leadId === actor.agentId,
          })
        );
      }
      return summaries.sort((left, right) => byText(left.name, right.name));
    }),
  registerWebhook: (actor, requestId, webhookUrl) =>
    Effect.gen(function* () {
      yield* webhookOf(requestId, "register_webhook", webhookUrl);
      const existing = yield* host.book.get(actor.agentId);
      const secret =
        existing === undefined ? yield* makeSecret() : existing.secret;
      yield* host.book.put(actor.agentId, {
        admin: actor.admin,
        secret,
        url: webhookUrl,
      });
      const state = yield* host.agents();
      const roomIds: RoomId[] = [];
      for (const room of state.rooms) {
        yield* host.legacy.room(room.roomId);
        const live = yield* host.rooms.state(room.roomId);
        if (live.members.some((member) => member.agentId === actor.agentId)) {
          roomIds.push(room.roomId);
        }
      }
      return new WebhookRegistration({ roomIds, webhookUrl });
    }),
  releaseRoom: (actor, requestId, roomId) =>
    Effect.gen(function* () {
      if (!actor.admin) {
        return yield* Effect.fail(denied(requestId, "release_room"));
      }
      yield* host.settle(
        host.directory.send(directoryTarget, new ReleaseRoom({ roomId })),
        contextFor(requestId, roomId, undefined, audit, editVerb)
      );
      return new Ack({ ok: true });
    }),
  resolve: (tokenHash, adminTokenHash, adminName) =>
    Effect.gen(function* () {
      yield* host.legacy.directory();
      const requestId = yield* orSchema(
        makeRequestId(),
        authenticateIdFailed()
      );
      const state = yield* host.agents();
      const adminAgent = state.agents.find((item) => item.admin === true);
      const decision = decideAdmin({
        envHash: adminTokenHash,
        presentedHash: tokenHash,
        storedHash: adminAgent?.tokenHash,
      });
      if (decision === "bootstrap") {
        return yield* bootstrap(host, requestId, adminName, adminTokenHash);
      }
      const agent = state.agents.find((item) => item.tokenHash === tokenHash);
      if (agent === undefined) {
        return yield* Effect.fail(unrecognized(requestId));
      }
      return new IdentityView({
        admin: agent.admin === true,
        agentId: agent.agentId,
        displayName: agent.displayName,
        kind: agent.kind,
      });
    }),
  retireAgent: (actor, requestId, agentId) =>
    Effect.gen(function* () {
      if (!actor.admin) {
        return yield* Effect.fail(denied(requestId, "retire_agent"));
      }
      yield* host.settle(
        host.directory.send(directoryTarget, new RetireAgent({ agentId })),
        contextFor(requestId, undefined, undefined, audit, editVerb, agentId)
      );
      return new Ack({ ok: true });
    }),
  rotateToken: (actor, requestId, agentId) =>
    Effect.gen(function* () {
      if (!actor.admin && actor.agentId !== agentId) {
        return yield* Effect.fail(denied(requestId, "rotate_token"));
      }
      const state = yield* host.agents();
      const agent = state.agents.find((item) => item.agentId === agentId);
      if (agent === undefined) {
        return yield* Effect.fail(missingAgent(requestId, agentId));
      }
      const view = new IdentityView({
        admin: agent.admin === true,
        agentId: agent.agentId,
        displayName: agent.displayName,
        kind: agent.kind,
      });
      const token = yield* makeSecret();
      const tokenHash = yield* hashToken(token);
      yield* host.settle(
        host.directory.send(
          directoryTarget,
          new RotateToken({ agentId, tokenHash })
        ),
        contextFor(requestId, undefined, undefined, audit, editVerb, agentId)
      );
      const stored = yield* host.book.get(agentId);
      return new CreatedAgent({
        agent: view,
        token,
        webhookSecret: rememberedSecret(stored),
      });
    }),
});

export const rememberedSecret = (
  stored: { readonly secret: string } | undefined
) => (stored === undefined ? "" : stored.secret);

const bootstrap = (
  host: ChatHost,
  requestId: RequestId,
  adminName: string,
  adminTokenHash: string
) =>
  Effect.gen(function* () {
    const name = yield* decodeDisplayName(adminName).pipe(
      Effect.catchTag("SchemaError", () => Effect.fail(badAdminName(requestId)))
    );
    const agentId = yield* orSchema(makeAgentId(), authenticateIdFailed());
    const webhookSecret = yield* makeSecret();
    yield* host.settle(
      host.directory.send(
        directoryTarget,
        new RegisterAgent({
          admin: true,
          agentId,
          displayName: name,
          kind: "human",
          tokenHash: adminTokenHash,
        })
      ),
      contextFor(requestId, undefined, undefined, audit, editVerb, agentId)
    );
    yield* host.book.put(agentId, {
      admin: true,
      secret: webhookSecret,
      url: null,
    });
    return new IdentityView({
      admin: true,
      agentId,
      displayName: name,
      kind: "human",
    });
  });

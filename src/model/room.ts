import { Aggregate } from "alchemy/Domain";
import type { DateTime } from "effect";
import type { AgentId } from "../domain/ids.ts";
import { RoomId } from "../domain/ids.ts";
import { AlreadyOpen } from "./rejections.ts";
import {
  EditMessage,
  ExpireWake,
  InviteMember,
  JoinRoom,
  LeaveRoom,
  MarkRead,
  OpenRoom,
  PostMessage,
  ReactToMessage,
  RecordDelivery,
  RedactMessage,
} from "./room-commands.ts";
import {
  applyDelivery,
  applyEdited,
  applyInvited,
  applyJoined,
  applyLead,
  applyLeft,
  applyNotice,
  applyOpened,
  applyPaused,
  applyPosted,
  applyReacted,
  applyRead,
  applyRedacted,
  applyResumed,
} from "./room-evolve.ts";
import {
  decideEdit,
  decideExpire,
  decideInvite,
  decideJoin,
  decideLeave,
  decidePost,
  decideReact,
  decideRead,
  decideRecord,
  decideRedact,
  epochMillis,
} from "./room-rules.ts";
import {
  initialRoom,
  type MemberState,
  type MessageState,
  RoomOpened,
  RoomState,
} from "./room-shape.ts";

const on =
  <E>(apply: (state: RoomState, event: E) => RoomState) =>
  (state: RoomState, event: E) =>
    apply(state, event);

export const Room = Aggregate("Room", {
  commands: [
    OpenRoom,
    InviteMember,
    JoinRoom,
    LeaveRoom,
    PostMessage,
    EditMessage,
    RedactMessage,
    ReactToMessage,
    MarkRead,
    RecordDelivery,
    ExpireWake,
  ],
  decide: {
    EditMessage: (state: RoomState, command: EditMessage) =>
      decideEdit(state, command),
    ExpireWake: (state: RoomState, command: ExpireWake) =>
      decideExpire(state, command.id),
    InviteMember: (state: RoomState, command: InviteMember) =>
      decideInvite(state, command),
    JoinRoom: (state: RoomState, command: JoinRoom) =>
      decideJoin(state, command),
    LeaveRoom: (state: RoomState, command: LeaveRoom) =>
      decideLeave(state, command),
    MarkRead: (state: RoomState, command: MarkRead) =>
      decideRead(state, command),
    OpenRoom: (state: RoomState, command: OpenRoom) =>
      state.open
        ? new AlreadyOpen()
        : [
            new RoomOpened({
              leadId: command.leadId,
              members: command.members,
              name: command.name,
              topic: command.topic,
            }),
          ],
    PostMessage: (
      state: RoomState,
      command: PostMessage,
      ctx: { readonly now: DateTime.Utc }
    ) => decidePost(state, command, epochMillis(ctx.now)),
    ReactToMessage: (state: RoomState, command: ReactToMessage) =>
      decideReact(state, command),
    RecordDelivery: (state: RoomState, command: RecordDelivery) =>
      decideRecord(state, command.id),
    RedactMessage: (state: RoomState, command: RedactMessage) =>
      decideRedact(state, command),
  },
  evolve: {
    LeadTransferred: on<{ readonly agentId: AgentId }>((state, event) =>
      applyLead(state, event.agentId)
    ),
    MemberInvited: on<{ readonly member: MemberState }>((state, event) =>
      applyInvited(state, event.member)
    ),
    MemberJoined: on<{ readonly agentId: AgentId }>((state, event) =>
      applyJoined(state, event.agentId)
    ),
    MemberLeft: on<{ readonly agentId: AgentId }>((state, event) =>
      applyLeft(state, event.agentId)
    ),
    MessageEdited: on<{
      readonly body: string;
      readonly mentions: readonly string[];
      readonly seq: number;
    }>((state, event) => applyEdited(state, event)),
    MessagePosted: on<{
      readonly message: MessageState;
      readonly targets: readonly AgentId[];
    }>((state, event) => applyPosted(state, event)),
    MessageReacted: on<{
      readonly added: boolean;
      readonly agentId: AgentId;
      readonly emoji: string;
      readonly seq: number;
    }>((state, event) => applyReacted(state, event)),
    MessageRedacted: on<{ readonly seq: number }>((state, event) =>
      applyRedacted(state, event.seq)
    ),
    PauseNoticePosted: on<{ readonly message: MessageState }>((state, event) =>
      applyNotice(state, event.message)
    ),
    ReadAdvanced: on<{ readonly agentId: AgentId; readonly seq: number }>(
      (state, event) => applyRead(state, event)
    ),
    RoomOpened: on<{
      readonly leadId: AgentId;
      readonly members: readonly MemberState[];
      readonly name: string;
      readonly topic: string;
    }>((state, event) => applyOpened(state, event)),
    RoomPaused: (state: RoomState) => applyPaused(state),
    RoomResumed: (state: RoomState) => applyResumed(state),
    WakeDelivered: on<{ readonly id: string }>((state, event) =>
      applyDelivery(state, event.id, "delivered")
    ),
    WakeExpired: on<{ readonly id: string }>((state, event) =>
      applyDelivery(state, event.id, "expired")
    ),
  },
  id: RoomId,
  initial: initialRoom,
  reply: {
    OpenRoom: (state: RoomState) => ({ name: state.name }),
    PostMessage: (state: RoomState) => ({
      seq: state.messages.at(-1)?.seq ?? 0,
    }),
  },
  state: RoomState,
});

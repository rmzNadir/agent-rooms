# Language

| Term | Meaning |
| --- | --- |
| Room | One conversation. Its members, messages, pause, and hop count change together. |
| Member | An agent or human inside a room. A lead is a member. |
| Agent | A bot registered in the directory. |
| Message | A seq-numbered post, edit, redaction, or reaction. |
| Mention | An `@agentId` an agent must include, unless it is the only member. |
| Thread | The message a reply targets. |
| Wake | A webhook attempt recorded on the room. |
| Cursor | The last seq a member has read. |
| HopLimit | Eight posts, then the room pauses. |
| Pause | The lead's resume is the only post accepted. |

Commands: OpenRoom, InviteMember, JoinRoom, LeaveRoom, PostMessage, EditMessage, RedactMessage, ReactToMessage, MarkRead, RecordDelivery, ExpireWake, RegisterAgent, RotateToken, ReserveRoom.

Events use the past tense: RoomOpened, MemberInvited, MemberJoined, MemberLeft, MessagePosted, RoomPaused, WakeDelivered, WakeExpired.

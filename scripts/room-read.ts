import type { AppCall } from "./http-text.ts";
import {
  agentList,
  failureCode,
  memberList,
  type RoomHead,
  roomHeads,
  roomSnap,
  toolCall,
  transcriptPage,
  whoamiName,
} from "./room-parse.ts";
import {
  type Json,
  type MemberSnap,
  type RoomBackup,
  type RoomSnap,
  readPayload,
  stitchTranscript,
} from "./snapshot-diff.ts";

export const TRANSCRIPT_LIMIT = 200;
const PAGE_CAP = 500;

const toolPayload = async (
  http: AppCall,
  token: string,
  id: number,
  name: string,
  args: { readonly [key: string]: Json }
) => {
  const reply = await http("POST", "/mcp", token, toolCall(id, name, args));
  if (reply.status !== 200) {
    throw new Error(`room tool failed ${reply.status}`);
  }
  return readPayload(reply.text);
};

const requireMembers = (
  payload: ReturnType<typeof readPayload>,
  roomId: string
) => {
  const members = memberList(payload);
  if (members === undefined) {
    throw new Error(`room ${roomId} members ${failureCode(payload)}`);
  }
  return members;
};

const requirePage = (
  payload: ReturnType<typeof readPayload>,
  roomId: string
) => {
  const page = transcriptPage(payload);
  if (page === undefined) {
    throw new Error(`room ${roomId} transcript ${failureCode(payload)}`);
  }
  return page;
};

const readMembers = async (
  http: AppCall,
  token: string,
  roomId: string,
  id: number
) =>
  requireMembers(
    await toolPayload(http, token, id, "members", { room: roomId }),
    roomId
  );

const readPage = async (
  http: AppCall,
  token: string,
  roomId: string,
  id: number,
  since: number,
  page: number,
  pages: readonly string[]
): Promise<{ readonly id: number; readonly pages: readonly string[] }> => {
  if (page >= PAGE_CAP) {
    throw new Error(`room ${roomId} transcript exceeded page cap`);
  }
  const snap = requirePage(
    await toolPayload(http, token, id, "read_transcript", {
      format: "json",
      limit: TRANSCRIPT_LIMIT,
      room: roomId,
      since,
    }),
    roomId
  );
  const collected = [...pages, snap.text];
  if (snap.count < TRANSCRIPT_LIMIT || snap.next === undefined) {
    return { id: id + 1, pages: collected };
  }
  return readPage(http, token, roomId, id + 1, snap.next, page + 1, collected);
};

export const readPages = (
  http: AppCall,
  token: string,
  roomId: string,
  startId: number
) => readPage(http, token, roomId, startId, 0, 0, []);

const readHeads = async (
  http: AppCall,
  token: string,
  heads: readonly RoomHead[],
  index: number,
  id: number,
  rooms: readonly RoomSnap[]
): Promise<readonly RoomSnap[]> => {
  const head = heads[index];
  if (head === undefined) {
    return rooms;
  }
  const members = await readMembers(http, token, head.roomId, id);
  const read = await readPages(http, token, head.roomId, id + 1);
  return readHeads(http, token, heads, index + 1, read.id, [
    ...rooms,
    assemble(head, members, read.pages),
  ]);
};

const assemble = (
  head: RoomHead,
  members: readonly MemberSnap[],
  pages: readonly string[]
): RoomSnap => {
  const transcript = stitchTranscript(pages);
  const messages = readPayload(transcript);
  const parsed = roomSnap(
    readPayload(
      JSON.stringify({
        ...head,
        memberCount: members.length,
        members,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        transcript,
      })
    )
  );
  if (parsed === undefined) {
    throw new Error(`room ${head.roomId} snapshot incomplete`);
  }
  return parsed;
};

export const readBackup = async (
  http: AppCall,
  token: string,
  takenAt: string
): Promise<RoomBackup> => {
  const agentsReply = await http("GET", "/admin/agents", token);
  if (agentsReply.status !== 200) {
    throw new Error(`admin agents ${agentsReply.status}`);
  }
  const roomsReply = await http("GET", "/api/rooms", token);
  if (roomsReply.status !== 200) {
    throw new Error(`rooms ${roomsReply.status}`);
  }
  const agents = agentList(readPayload(agentsReply.text));
  const heads = roomHeads(readPayload(roomsReply.text));
  if (agents === undefined || heads === undefined) {
    throw new Error("admin list omitted an id");
  }
  const rooms = await readHeads(http, token, heads, 0, 1, []);
  return { agents, rooms, takenAt, version: 1 };
};

export const authProblems = async (
  http: AppCall,
  token: string,
  label: string
) => {
  const reply = await http("GET", "/api/whoami", token);
  if (reply.status !== 200) {
    return [`${label} whoami ${reply.status}`];
  }
  const name = whoamiName(readPayload(reply.text));
  if (name === undefined || name.length === 0) {
    return [`${label} whoami omitted displayName`];
  }
  return [];
};

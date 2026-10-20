import {
  type AgentSnap,
  boolField,
  field,
  type Json,
  type MemberSnap,
  numberField,
  type RoomBackup,
  type RoomSnap,
  readPayload,
  textField,
  toolFailed,
  toolText,
} from "./snapshot-diff.ts";

export interface RoomHead {
  readonly leadId: string;
  readonly name: string;
  readonly roomId: string;
  readonly topic: string;
}

export interface PageSnap {
  readonly count: number;
  readonly next: number | undefined;
  readonly text: string;
}

export interface CreatedLogin {
  readonly agentId: string;
  readonly displayName: string;
  readonly token: string;
}

const mapRows = <Row>(
  payload: Json,
  map: (row: Json) => Row | undefined
): readonly Row[] | undefined => {
  if (!Array.isArray(payload)) {
    return;
  }
  const rows = payload.flatMap((row) => {
    const mapped = map(row);
    return mapped === undefined ? [] : [mapped];
  });
  if (rows.length !== payload.length) {
    return;
  }
  return rows;
};

export const agentSnap = (value: Json): AgentSnap | undefined => {
  const admin = boolField(value, "admin");
  const agentId = textField(value, "agentId");
  const displayName = textField(value, "displayName");
  const kind = textField(value, "kind");
  if (
    admin === undefined ||
    agentId === undefined ||
    displayName === undefined ||
    kind === undefined
  ) {
    return;
  }
  return { admin, agentId, displayName, kind };
};

export const memberSnap = (value: Json): MemberSnap | undefined => {
  const agentId = textField(value, "agentId");
  const displayName = textField(value, "displayName");
  const joined = boolField(value, "joined");
  const kind = textField(value, "kind");
  const lastReadSeq = numberField(value, "lastReadSeq");
  const role = textField(value, "role");
  if (
    agentId === undefined ||
    displayName === undefined ||
    joined === undefined ||
    kind === undefined ||
    lastReadSeq === undefined ||
    role === undefined
  ) {
    return;
  }
  return { agentId, displayName, joined, kind, lastReadSeq, role };
};

export const roomHead = (value: Json): RoomHead | undefined => {
  const leadId = textField(value, "leadId");
  const name = textField(value, "name");
  const roomId = textField(value, "roomId");
  const topic = textField(value, "topic");
  if (
    leadId === undefined ||
    name === undefined ||
    roomId === undefined ||
    topic === undefined
  ) {
    return;
  }
  return { leadId, name, roomId, topic };
};

export const agentList = (payload: Json) => mapRows(payload, agentSnap);

export const roomHeads = (payload: Json) => mapRows(payload, roomHead);

export const whoamiName = (payload: Json) => textField(payload, "displayName");

export const failureCode = (payload: Json) => {
  const raw = toolText(payload);
  if (raw !== undefined) {
    return textField(readPayload(raw), "code") ?? "tool failed";
  }
  return textField(field(payload, "error"), "message") ?? "tool failed";
};

const toolJson = (payload: Json) => {
  if (toolFailed(payload)) {
    return;
  }
  const raw = toolText(payload);
  if (raw === undefined) {
    return;
  }
  return readPayload(raw);
};

export const memberList = (payload: Json) => {
  const parsed = toolJson(payload);
  if (parsed === undefined || toolFailed(payload)) {
    return;
  }
  return mapRows(field(parsed, "members") ?? null, memberSnap);
};

const messageCount = (text: string) => {
  const messages = field(readPayload(text), "messages");
  return Array.isArray(messages) ? messages.length : undefined;
};

export const transcriptPage = (payload: Json): PageSnap | undefined => {
  const parsed = toolJson(payload);
  if (parsed === undefined || toolFailed(payload)) {
    return;
  }
  const text = textField(parsed, "text");
  if (text === undefined) {
    return;
  }
  const count = messageCount(text);
  if (count === undefined) {
    return;
  }
  return { count, next: numberField(parsed, "nextCursor"), text };
};

const transcriptCount = (transcript: string) => {
  const parsed = readPayload(transcript);
  return Array.isArray(parsed) ? parsed.length : undefined;
};

export const roomSnap = (value: Json): RoomSnap | undefined => {
  const head = roomHead(value);
  const memberCount = numberField(value, "memberCount");
  const messageCountValue = numberField(value, "messageCount");
  const transcript = textField(value, "transcript");
  const members = mapRows(field(value, "members") ?? null, memberSnap);
  if (
    head === undefined ||
    memberCount === undefined ||
    messageCountValue === undefined ||
    transcript === undefined ||
    members === undefined
  ) {
    return;
  }
  if (memberCount !== members.length) {
    return;
  }
  if (messageCountValue !== transcriptCount(transcript)) {
    return;
  }
  return {
    leadId: head.leadId,
    memberCount,
    members,
    messageCount: messageCountValue,
    name: head.name,
    roomId: head.roomId,
    topic: head.topic,
    transcript,
  };
};

export const parseBackup = (text: string): RoomBackup => {
  const payload = readPayload(text);
  const takenAt = textField(payload, "takenAt");
  const agents = agentList(field(payload, "agents") ?? null);
  const rooms = mapRows(field(payload, "rooms") ?? null, roomSnap);
  if (numberField(payload, "version") !== 1) {
    throw new Error("backup file is not version 1");
  }
  if (takenAt === undefined || agents === undefined || rooms === undefined) {
    throw new Error("backup file is missing rooms or agents");
  }
  return { agents, rooms, takenAt, version: 1 };
};

export const createdAgent = (text: string): CreatedLogin | undefined => {
  const payload = readPayload(text);
  const agent = field(payload, "agent");
  const token = textField(payload, "token");
  const agentId = textField(agent, "agentId");
  const displayName = textField(agent, "displayName");
  if (
    token === undefined ||
    agentId === undefined ||
    displayName === undefined
  ) {
    return;
  }
  return { agentId, displayName, token };
};

export const toolCall = (
  id: number,
  name: string,
  args: { readonly [key: string]: Json }
) =>
  JSON.stringify({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: args, name },
  });

const roomIdPattern = /room_[0-9a-f]{24}/u;

export const roomIdIn = (text: string) => roomIdPattern.exec(text)?.[0];

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export interface MemberSnap {
  readonly agentId: string;
  readonly displayName: string;
  readonly joined: boolean;
  readonly kind: string;
  readonly lastReadSeq: number;
  readonly role: string;
}

export interface RoomSnap {
  readonly leadId: string;
  readonly memberCount: number;
  readonly members: readonly MemberSnap[];
  readonly messageCount: number;
  readonly name: string;
  readonly roomId: string;
  readonly topic: string;
  readonly transcript: string;
}

export interface AgentSnap {
  readonly admin: boolean;
  readonly agentId: string;
  readonly displayName: string;
  readonly kind: string;
}

export interface RoomBackup {
  readonly agents: readonly AgentSnap[];
  readonly rooms: readonly RoomSnap[];
  readonly takenAt: string;
  readonly version: 1;
}

export interface VersionShare {
  readonly percentage: number;
  readonly versionId: string;
}

export interface DeploymentRow {
  readonly createdOn: string;
  readonly versions: readonly VersionShare[];
}

const DAY_MS = 86_400_000;
const nightlyKey = /^nightly\/(\d{4}-\d{2}-\d{2})\.json$/u;
const deployKey = /^deploy\/(\d{4})-?(\d{2})-?(\d{2})T/u;

export const parseJson = (text: string): Json => JSON.parse(text) as Json;

const dataPrefix = "data:";

const dataLines = (text: string) =>
  text.split("\n").flatMap((line) => {
    if (!line.startsWith(dataPrefix)) {
      return [];
    }
    const payload = line.slice(dataPrefix.length).trim();
    return payload.length === 0 ? [] : [payload];
  });

export const jsonDocument = (text: string) => {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("event:") || trimmed.startsWith(dataPrefix))) {
    return text;
  }
  const lines = dataLines(trimmed);
  const [only] = lines;
  if (lines.length !== 1 || only === undefined) {
    return text;
  }
  return only;
};

export const readPayload = (text: string): Json => {
  try {
    return parseJson(jsonDocument(text));
  } catch {
    return { success: false };
  }
};

export const httpOk = (status: number) => status >= 200 && status < 300;

export const backupPrefix = (value: string | undefined) =>
  value === "deploy" || value === "nightly" ? value : undefined;

export const field = (
  value: Json | undefined,
  key: string
): Json | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as { readonly [name: string]: Json };
  return record[key];
};

export const textField = (value: Json | undefined, key: string) => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

export const numberField = (value: Json | undefined, key: string) => {
  const found = field(value, key);
  return typeof found === "number" ? found : undefined;
};

export const boolField = (value: Json | undefined, key: string) => {
  const found = field(value, key);
  return typeof found === "boolean" ? found : undefined;
};

const cloudflareFailed = "cloudflare request failed";

export const cfError = (payload: Json) => {
  const errors = field(payload, "errors");
  if (!Array.isArray(errors)) {
    return cloudflareFailed;
  }
  return textField(errors[0], "message") ?? cloudflareFailed;
};

export const cfFailure = (payload: Json) => {
  const errors = field(payload, "errors");
  const first = Array.isArray(errors) ? errors[0] : undefined;
  const code = numberField(first, "code");
  const message = textField(first, "message");
  if (code === undefined) {
    return message ?? cloudflareFailed;
  }
  if (message === undefined) {
    return `${code}`;
  }
  return `${code} ${message}`;
};

export const bucketReady = (status: number, payload: Json) =>
  field(payload, "success") === true ||
  status === 409 ||
  cfError(payload).toLowerCase().includes("already");

export const objectKeys = (payload: Json) => {
  const result = field(payload, "result");
  if (!Array.isArray(result)) {
    return [];
  }
  return result.flatMap((row) => {
    const key = textField(row, "key");
    return key === undefined ? [] : [key];
  });
};

export const keyTime = (key: string): number | undefined => {
  const night = nightlyKey.exec(key);
  if (night?.[1] !== undefined) {
    return Date.parse(`${night[1]}T00:00:00Z`);
  }
  const staged = deployKey.exec(key);
  if (
    staged?.[1] !== undefined &&
    staged[2] !== undefined &&
    staged[3] !== undefined
  ) {
    return Date.parse(`${staged[1]}-${staged[2]}-${staged[3]}T00:00:00Z`);
  }
  return undefined;
};

export const expiredKeys = (
  keys: readonly string[],
  now: number,
  days: number
) =>
  keys.filter((key) => {
    const time = keyTime(key);
    return time !== undefined && now - time > days * DAY_MS;
  });

export const backupKey = (prefix: string, iso: string, sha: string) => {
  if (prefix === "nightly") {
    return `nightly/${iso.slice(0, 10)}.json`;
  }
  const stamp = iso.replaceAll("-", "").replaceAll(":", "").replace(".000", "");
  return `deploy/${stamp}-${sha}.json`;
};

export const toolText = (payload: Json) => {
  const content = field(field(payload, "result"), "content");
  if (!Array.isArray(content)) {
    return;
  }
  return textField(content[0], "text");
};

export const toolFailed = (payload: Json) =>
  field(field(payload, "result"), "isError") === true;

export const stitchTranscript = (pages: readonly string[]) => {
  const messages: Json[] = [];
  for (const page of pages) {
    const list = field(readPayload(page), "messages");
    if (Array.isArray(list)) {
      messages.push(...list);
    }
  }
  return JSON.stringify(messages);
};

const byId = <Row>(rows: readonly Row[], idOf: (row: Row) => string) =>
  [...rows].sort((left, right) => idOf(left).localeCompare(idOf(right)));

const differ = <Row>(
  before: readonly Row[],
  after: readonly Row[],
  idOf: (row: Row) => string,
  changed: (left: Row, right: Row) => readonly string[],
  missing: (id: string) => string,
  extra: (id: string) => string
) => {
  const lines: string[] = [];
  const next = new Map(after.map((row) => [idOf(row), row]));
  for (const row of byId(before, idOf)) {
    const id = idOf(row);
    const found = next.get(id);
    if (found === undefined) {
      lines.push(missing(id));
      continue;
    }
    lines.push(...changed(row, found));
    next.delete(id);
  }
  for (const id of byId([...next.keys()], (key) => key)) {
    lines.push(extra(id));
  }
  return lines;
};

const agentLine = (before: AgentSnap, after: AgentSnap) => {
  if (
    before.admin === after.admin &&
    before.displayName === after.displayName &&
    before.kind === after.kind
  ) {
    return [];
  }
  return [`agent ${before.agentId} identity differs`];
};

export const agentDiff = (
  before: readonly AgentSnap[],
  after: readonly AgentSnap[]
) =>
  differ(
    before,
    after,
    (agent) => agent.agentId,
    agentLine,
    (agentId) => `agent ${agentId} missing after deploy`,
    (agentId) => `agent ${agentId} appeared after deploy`
  );

const memberSame = (before: MemberSnap, after: MemberSnap) =>
  before.joined === after.joined &&
  before.lastReadSeq === after.lastReadSeq &&
  before.role === after.role &&
  before.displayName === after.displayName &&
  before.kind === after.kind;

const memberLine = (roomId: string, before: MemberSnap, after: MemberSnap) =>
  memberSame(before, after)
    ? []
    : [`room ${roomId} member ${before.agentId} cursor or role differs`];

const memberDiff = (roomId: string, before: RoomSnap, after: RoomSnap) =>
  differ(
    before.members,
    after.members,
    (member) => member.agentId,
    (left, right) => memberLine(roomId, left, right),
    (agentId) => `room ${roomId} member ${agentId} missing`,
    (agentId) => `room ${roomId} member ${agentId} appeared`
  );

const countLine = (
  roomId: string,
  label: string,
  before: number,
  after: number
) =>
  before === after
    ? undefined
    : `room ${roomId} ${label} ${before} -> ${after}`;

const pushCount = (
  lines: string[],
  roomId: string,
  label: string,
  before: number,
  after: number
) => {
  const line = countLine(roomId, label, before, after);
  if (line !== undefined) {
    lines.push(line);
  }
};

const isRecord = (
  value: Json | undefined
): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameValue = (
  left: Json | undefined,
  right: Json | undefined
): boolean => {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return sameList(left, right);
  }
  if (isRecord(left) && isRecord(right)) {
    return sameRecord(left, right);
  }
  return false;
};

const sameList = (left: readonly Json[], right: readonly Json[]) =>
  left.length === right.length &&
  left.every((item, index) => sameValue(item, right[index]));

const sameRecord = (
  left: { readonly [key: string]: Json },
  right: { readonly [key: string]: Json }
) => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => sameValue(field(left, key), field(right, key)))
  );
};

const sameTranscript = (before: string, after: string) => {
  if (before === after) {
    return true;
  }
  try {
    return sameValue(parseJson(before), parseJson(after));
  } catch {
    return false;
  }
};

const priorLead = (room: RoomSnap) =>
  room.members.find((member) => member.role === "lead")?.agentId;

const leadChanged = (before: RoomSnap, after: RoomSnap) =>
  before.leadId !== after.leadId && priorLead(before) !== after.leadId;

const roomLine = (before: RoomSnap, after: RoomSnap) => {
  const lines: string[] = [];
  pushCount(
    lines,
    before.roomId,
    "messageCount",
    before.messageCount,
    after.messageCount
  );
  pushCount(
    lines,
    before.roomId,
    "memberCount",
    before.memberCount,
    after.memberCount
  );
  if (!sameTranscript(before.transcript, after.transcript)) {
    lines.push(`room ${before.roomId} transcript differs`);
  }
  if (leadChanged(before, after) || before.name !== after.name) {
    lines.push(`room ${before.roomId} name or lead differs`);
  }
  if (before.topic !== after.topic) {
    lines.push(`room ${before.roomId} topic differs`);
  }
  lines.push(...memberDiff(before.roomId, before, after));
  return lines;
};

export const roomDiff = (
  before: readonly RoomSnap[],
  after: readonly RoomSnap[]
) =>
  differ(
    before,
    after,
    (room) => room.roomId,
    roomLine,
    (roomId) => `room ${roomId} missing after deploy`,
    (roomId) => `room ${roomId} appeared after deploy`
  );

export const compareBackups = (before: RoomBackup, after: RoomBackup) => [
  ...agentDiff(before.agents, after.agents),
  ...roomDiff(before.rooms, after.rooms),
];

export const liveVersionId = (rows: readonly DeploymentRow[]) => {
  const [current] = [...rows].sort((left, right) =>
    left.createdOn < right.createdOn ? 1 : -1
  );
  if (current === undefined) {
    return;
  }
  return current.versions.find((item) => item.percentage === 100)?.versionId;
};

export const deploymentRows = (payload: Json): readonly DeploymentRow[] => {
  const deployments = field(field(payload, "result"), "deployments");
  if (!Array.isArray(deployments)) {
    return [];
  }
  return deployments.flatMap((row) => {
    const createdOn = textField(row, "created_on");
    const versions = field(row, "versions");
    if (createdOn === undefined || !Array.isArray(versions)) {
      return [];
    }
    return [
      {
        createdOn,
        versions: versions.flatMap((share) => {
          const versionId = textField(share, "version_id");
          const percentage = numberField(share, "percentage");
          if (versionId === undefined || percentage === undefined) {
            return [];
          }
          return [{ percentage, versionId }];
        }),
      },
    ];
  });
};

export const RETENTION_DAYS = 30;

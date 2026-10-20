import { Effect } from "effect";
import { execRows } from "../src/domain/sql-exec.ts";
import type { LegacyDirectory } from "../src/model/migrate.ts";
import type { StoredCredential } from "../src/runtime/credentials.ts";

const agentId = (tail: string) => `agent_${tail.padStart(24, "0")}`;
const roomId = (tail: string) => `room_${tail.padStart(24, "0")}`;

export const human = agentId("a1");
export const member = agentId("a2");
export const solo = agentId("a3");
export const bot = agentId("a4");
export const ghost = agentId("a5");
export const kept = agentId("a6");
export const roomOnly = agentId("a7");
export const roomA = roomId("b1");
export const hop = 7;

export const statement = (
  sql: string,
  ...bindings: Array<string | number | null>
) => execRows(sql, bindings, "seed");

const cell = (value: string | undefined) => value ?? "";

const kindOf = (value: string | undefined): "agent" | "human" =>
  value === "human" ? "human" : "agent";

const roleOf = (value: string | undefined): "lead" | "member" =>
  value === "lead" ? "lead" : "member";

const nullable = (value: string | undefined): string | null => {
  if (value === "-" || value === undefined) {
    return null;
  }
  if (value === "_") {
    return "";
  }
  return value;
};

const mentionList = (token: string): readonly string[] => {
  if (token === "_" || token === "[]") {
    return [];
  }
  return [token];
};

const mentionsJson = (token: string) =>
  token === "_" ? "" : JSON.stringify(mentionList(token));

const optionalNumber = (token: string | undefined): number | null =>
  token === undefined || token === "-" || token === "_" ? null : Number(token);

const parseAgent = (line: string) => {
  const [tail, displayName, kind, admin, tokenHash, webhookSecret, webhookUrl] =
    line.split(" ");
  return {
    admin: Number(admin),
    agentId: agentId(cell(tail)),
    displayName: cell(displayName),
    kind: kindOf(kind),
    tokenHash: cell(tokenHash),
    webhookSecret: nullable(webhookSecret) ?? "",
    webhookUrl: nullable(webhookUrl),
  };
};

type AgentSeed = ReturnType<typeof parseAgent>;

const agents: readonly AgentSeed[] = [
  "a1 human human 1 hash-human sec-human http://human",
  "a2 member agent 0 hash-member sec-member _",
  "a3 solo agent 1 hash-solo sec-solo http://solo",
  "a4 bot agent 0 hash-bot sec-bot _",
  "a5 ghost agent 0 hash-ghost _ -",
  "a6 kept agent 0 hash-kept sec-new http://kept",
].map(parseAgent);

const agentById = (id: string) => {
  const found = agents.find((agent) => agent.agentId === id);
  if (found === undefined) {
    throw new Error(id);
  }
  return found;
};

const blank = (value: string | null) => value ?? "";

const expectedAgent = (agent: AgentSeed) => ({
  admin: agent.admin === 1,
  agentId: agent.agentId,
  displayName: agent.displayName,
  kind: agent.kind,
  tokenHash: agent.tokenHash,
  webhookSecret: agent.webhookSecret,
  webhookUrl: blank(agent.webhookUrl),
});

const directoryMember = (agent: AgentSeed, role: "lead" | "member") => ({
  agentId: agent.agentId,
  displayName: agent.displayName,
  joined: true,
  kind: agent.kind,
  lastReadSeq: 0,
  role,
  webhookSecret: agent.webhookSecret,
  webhookUrl: blank(agent.webhookUrl),
});

const parseMemberSpec = (spec: string) =>
  spec.split(",").map((item) => {
    const [tail, role] = item.split(":");
    return directoryMember(agentById(agentId(cell(tail))), roleOf(role));
  });

const parseDirectoryRoom = (line: string) => {
  const [tail, name, topic, lead, members] = line.split(" ");
  return {
    hopCount: 0,
    leadId: agentId(cell(lead)),
    members: parseMemberSpec(cell(members)),
    messages: [],
    name: cell(name),
    paused: false,
    roomId: roomId(cell(tail)),
    topic: cell(topic),
  };
};

const directoryRoomLines = [
  "b1 ops delivery a1 a1:lead,a2:member",
  "b2 lab notes a2 a2:lead",
];

const membershipLines = ["b1 a1", "b1 a8", "b3 a1", "b1 a2", "b2 a2"];

export const expectedDirectory = {
  agents: agents.map(expectedAgent),
  rooms: directoryRoomLines.map(parseDirectoryRoom),
} satisfies LegacyDirectory;

export const tokenList = agents.map((agent) => agent.tokenHash);
export const directoryAdmins = agents.map((agent) =>
  agent.admin === 1 ? true : undefined
);
export const agentCount = agents.length;

interface RoomMemberSeed {
  readonly agentId: string;
  readonly displayName: string;
  readonly joined: number;
  readonly kind: "agent" | "human";
  readonly role: "lead" | "member";
  readonly webhookSecret: string;
  readonly webhookUrl: string | null;
}

const parseRoomMember = (line: string): RoomMemberSeed => {
  const [tail, displayName, kind, role, joined, webhookUrl, webhookSecret] =
    line.split(" ");
  return {
    agentId: agentId(cell(tail)),
    displayName: cell(displayName),
    joined: Number(joined),
    kind: kindOf(kind),
    role: roleOf(role),
    webhookSecret: nullable(webhookSecret) ?? "",
    webhookUrl: nullable(webhookUrl),
  };
};

const roomMembers: readonly RoomMemberSeed[] = [
  "a1 human human lead 1 http://human sec-room-human",
  "a7 only agent member 0 _ sec-room",
].map(parseRoomMember);

interface MessageSeed {
  readonly authorId: string;
  readonly authorKind: "agent" | "human";
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: number;
  readonly mentions: readonly string[];
  readonly mentionsJson: string;
  readonly redacted: number;
  readonly replySql: string | null;
  readonly replyTo: number | null;
  readonly seq: number;
  readonly threadRoot: number | null;
  readonly threadSql: string | null;
}

const parseMessage = (line: string): MessageSeed => {
  const [
    seq,
    tail,
    authorName,
    kind,
    body,
    mention,
    thread,
    reply,
    createdAt,
    redacted,
  ] = line.split(" ");
  return {
    authorId: agentId(cell(tail)),
    authorKind: kindOf(kind),
    authorName: cell(authorName),
    body: cell(body),
    createdAt: Number(createdAt),
    mentions: mentionList(cell(mention)),
    mentionsJson: mentionsJson(cell(mention)),
    redacted: Number(redacted),
    replySql: nullable(reply),
    replyTo: optionalNumber(reply),
    seq: Number(seq),
    threadRoot: optionalNumber(thread),
    threadSql: nullable(thread),
  };
};

const messages: readonly MessageSeed[] = [
  "1 a1 human human root [] - - 10 0",
  "2 a7 only agent reply ada 1 1 11 1",
  "3 a1 human human blank _ _ _ 12 0",
].map(parseMessage);

const parseReaction = (line: string) => {
  const [seq, tail, emoji] = line.split(" ");
  return {
    agentId: agentId(cell(tail)),
    emoji: cell(emoji),
    seq: Number(seq),
  };
};

const reactions = ["2 a7 wave", "9 a1 nope", "2 a1 plus"].map(parseReaction);

const reactionsFor = (seq: number) =>
  reactions
    .filter((reaction) => reaction.seq === seq)
    .map((reaction) => ({
      agentId: reaction.agentId,
      emoji: reaction.emoji,
    }));

const expectedMessage = (message: MessageSeed) => ({
  authorId: message.authorId,
  authorKind: message.authorKind,
  authorName: message.authorName,
  body: message.body,
  createdAt: message.createdAt,
  mentions: message.mentions,
  reactions: reactionsFor(message.seq),
  redacted: message.redacted === 1,
  replyTo: message.replyTo,
  seq: message.seq,
  threadRoot: message.threadRoot,
});

const expectedRoomMember = (item: RoomMemberSeed) => ({
  agentId: item.agentId,
  displayName: item.displayName,
  joined: item.joined === 1,
  kind: item.kind,
  lastReadSeq: 0,
  role: item.role,
  webhookSecret: item.webhookSecret,
  webhookUrl: blank(item.webhookUrl),
});

export const expectedRoom = (paused: number) => ({
  hopCount: hop,
  leadId: human,
  members: roomMembers.map(expectedRoomMember),
  messages: messages.map(expectedMessage),
  name: "ops",
  paused: paused === 1,
  roomId: roomA,
  topic: "delivery",
});

export const messageBodies = messages.map((message) => message.body);
export const messageCount = messages.length;

const stored = (
  admin: boolean,
  secret: string,
  webhookUrl: string | null
): StoredCredential => ({
  admin,
  secret,
  url: blank(webhookUrl).length === 0 ? null : blank(webhookUrl),
});

export const directoryCredential = (id: string) => {
  const agent = agentById(id);
  return stored(agent.admin === 1, agent.webhookSecret, agent.webhookUrl);
};

export const roomCredential = (id: string) => {
  const item = roomMembers.find((memberSeed) => memberSeed.agentId === id);
  if (item === undefined) {
    throw new Error(id);
  }
  return stored(false, item.webhookSecret, item.webhookUrl);
};

const createAgents = statement(
  "CREATE TABLE agents (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL, admin INTEGER NOT NULL, token_hash TEXT NOT NULL, webhook_url TEXT, webhook_secret TEXT NOT NULL)"
);
const createRooms = statement(
  "CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL, lead_id TEXT NOT NULL)"
);
const createMemberships = statement(
  "CREATE TABLE memberships (room_id TEXT NOT NULL, agent_id TEXT NOT NULL)"
);
const createFlags = statement(
  "CREATE TABLE room_flags (id INTEGER PRIMARY KEY, name TEXT, topic TEXT, lead_id TEXT, hop_count INTEGER, paused INTEGER)"
);
const createMembers = statement(
  "CREATE TABLE members (agent_id TEXT PRIMARY KEY, display_name TEXT, kind TEXT, role TEXT, joined INTEGER, webhook_url TEXT, webhook_secret TEXT)"
);
const createMessages = statement(
  "CREATE TABLE messages (seq INTEGER, id TEXT, author_id TEXT, author_name TEXT, author_kind TEXT, body TEXT, mentions_json TEXT, thread_root TEXT, reply_to TEXT, created_at INTEGER, redacted INTEGER)"
);
const createReactions = statement(
  "CREATE TABLE reactions (seq INTEGER, agent_id TEXT, emoji TEXT)"
);

export const seedDirectory = Effect.gen(function* () {
  yield* createAgents;
  for (const agent of agents) {
    yield* statement(
      "INSERT INTO agents (id, display_name, kind, admin, token_hash, webhook_url, webhook_secret) VALUES (?, ?, ?, ?, ?, ?, ?)",
      agent.agentId,
      agent.displayName,
      agent.kind,
      agent.admin,
      agent.tokenHash,
      agent.webhookUrl,
      agent.webhookSecret
    );
  }
  yield* createRooms;
  for (const line of directoryRoomLines) {
    const [tail, name, topic, lead] = line.split(" ");
    yield* statement(
      "INSERT INTO rooms (id, name, topic, lead_id) VALUES (?, ?, ?, ?)",
      roomId(cell(tail)),
      cell(name),
      cell(topic),
      agentId(cell(lead))
    );
  }
  yield* createMemberships;
  for (const line of membershipLines) {
    const [roomTail, agentTail] = line.split(" ");
    yield* statement(
      "INSERT INTO memberships (room_id, agent_id) VALUES (?, ?)",
      roomId(cell(roomTail)),
      agentId(cell(agentTail))
    );
  }
});

export const seedRoom = (paused: number) =>
  Effect.gen(function* () {
    yield* createFlags;
    yield* statement(
      "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, 'ops', 'delivery', ?, ?, ?)",
      human,
      hop,
      paused
    );
    yield* createMembers;
    for (const item of roomMembers) {
      yield* statement(
        "INSERT INTO members (agent_id, display_name, kind, role, joined, webhook_url, webhook_secret) VALUES (?, ?, ?, ?, ?, ?, ?)",
        item.agentId,
        item.displayName,
        item.kind,
        item.role,
        item.joined,
        item.webhookUrl,
        item.webhookSecret
      );
    }
    yield* createMessages;
    for (const message of messages) {
      yield* statement(
        "INSERT INTO messages (seq, id, author_id, author_name, author_kind, body, mentions_json, thread_root, reply_to, created_at, redacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        message.seq,
        `msg_${message.seq}`,
        message.authorId,
        message.authorName,
        message.authorKind,
        message.body,
        message.mentionsJson,
        message.threadSql,
        message.replySql,
        message.createdAt,
        message.redacted
      );
    }
    yield* createReactions;
    for (const reaction of reactions) {
      yield* statement(
        "INSERT INTO reactions (seq, agent_id, emoji) VALUES (?, ?, ?)",
        reaction.seq,
        reaction.agentId,
        reaction.emoji
      );
    }
  });

export const createMigrated = statement(
  "CREATE TABLE domain_migrated (id INTEGER PRIMARY KEY, done INTEGER NOT NULL)"
);

export const seedEmptyFlags = createFlags;

export const seedFlagRow = Effect.gen(function* () {
  yield* createFlags;
  yield* statement(
    "INSERT INTO room_flags (id, name, topic, lead_id, hop_count, paused) VALUES (1, 'ops', 'delivery', ?, 1, 0)",
    human
  );
});

export const seedMention = (mentions: string) =>
  Effect.gen(function* () {
    yield* seedFlagRow;
    yield* createMembers;
    yield* statement(
      "INSERT INTO members (agent_id, display_name, kind, role, joined, webhook_url, webhook_secret) VALUES (?, 'human', 'human', 'lead', 1, '', '')",
      human
    );
    yield* createMessages;
    yield* statement(
      "INSERT INTO messages (seq, id, author_id, author_name, author_kind, body, mentions_json, thread_root, reply_to, created_at, redacted) VALUES (1, 'm', ?, 'human', 'human', 'x', ?, NULL, NULL, 1, 0)",
      human,
      mentions
    );
  });

const listedAgent = (
  agent: AgentSeed,
  webhookSecret: string | undefined,
  webhookUrl: string | undefined
) => ({
  admin: agent.admin === 1,
  agentId: agent.agentId,
  displayName: agent.displayName,
  kind: agent.kind,
  tokenHash: agent.tokenHash,
  ...(webhookSecret === undefined ? {} : { webhookSecret }),
  ...(webhookUrl === undefined ? {} : { webhookUrl }),
});

export const bareDirectory = (): LegacyDirectory => ({
  agents: [
    listedAgent(agentById(bot), agentById(bot).webhookSecret, undefined),
    listedAgent(agentById(ghost), undefined, undefined),
  ],
  rooms: [],
});

export const outsideDirectory = (): LegacyDirectory => ({
  agents: [],
  rooms: [
    {
      hopCount: 0,
      leadId: roomOnly,
      members: [
        {
          agentId: roomOnly,
          displayName: "only",
          joined: false,
          kind: "agent",
          lastReadSeq: 0,
          role: "member",
          webhookSecret: "sec-only",
          webhookUrl: "",
        },
      ],
      messages: [],
      name: "ops",
      paused: false,
      roomId: roomA,
      topic: "delivery",
    },
  ],
});

import { describe, expect, test } from "bun:test";
import { memberList } from "../scripts/room-parse.ts";
import {
  type AgentSnap,
  agentDiff,
  backupKey,
  backupPrefix,
  boolField,
  bucketReady,
  cfError,
  compareBackups,
  deploymentRows,
  expiredKeys,
  field,
  httpOk,
  keyTime,
  liveVersionId,
  numberField,
  objectKeys,
  parseJson,
  type RoomBackup,
  type RoomSnap,
  readPayload,
  roomDiff,
  scriptNameFromUrl,
  stitchTranscript,
  textField,
  toolFailed,
  toolText,
} from "../scripts/snapshot-diff.ts";

const agent = (
  agentId: string,
  displayName = agentId,
  kind = "agent",
  admin = false
): AgentSnap => ({ admin, agentId, displayName, kind });

const room = (roomId: string, patch: Partial<RoomSnap> = {}): RoomSnap => ({
  leadId: "agent_a",
  memberCount: 1,
  members: [
    {
      agentId: "agent_a",
      displayName: "ada",
      joined: true,
      kind: "agent",
      lastReadSeq: 3,
      role: "lead",
    },
  ],
  messageCount: 1,
  name: "launch",
  roomId,
  topic: "ship",
  transcript: '[{"body":"SECRET_BODY"}]',
  ...patch,
});

const backup = (
  rooms: readonly RoomSnap[],
  agents: readonly AgentSnap[] = [agent("agent_a")]
): RoomBackup => ({
  agents,
  rooms,
  takenAt: "2026-10-19T00:00:00.000Z",
  version: 1,
});

describe("json fields", () => {
  test("reads object fields and ignores other shapes", () => {
    const payload = parseJson('{"name":"ada","n":2,"ok":true,"list":[1]}');
    expect(textField(payload, "name")).toBe("ada");
    expect(numberField(payload, "n")).toBe(2);
    expect(boolField(payload, "ok")).toBe(true);
    expect(field(payload, "missing")).toBeUndefined();
    expect(textField(payload, "n")).toBeUndefined();
    expect(numberField(payload, "name")).toBeUndefined();
    expect(boolField(payload, "name")).toBeUndefined();
    expect(field(parseJson("[1]"), "name")).toBeUndefined();
    expect(field(null, "name")).toBeUndefined();
    expect(field(undefined, "name")).toBeUndefined();
    expect(readPayload("not json")).toEqual({ success: false });
  });

  test("reports cloudflare errors and bucket conflicts", () => {
    expect(cfError(parseJson("{}"))).toBe("cloudflare request failed");
    expect(cfError(parseJson('{"errors":[{"message":"nope"}]}'))).toBe("nope");
    expect(cfError(parseJson('{"errors":[{}]}'))).toBe(
      "cloudflare request failed"
    );
    expect(bucketReady(200, parseJson('{"success":true}'))).toBe(true);
    expect(bucketReady(409, parseJson("{}"))).toBe(true);
    expect(
      bucketReady(400, parseJson('{"errors":[{"message":"Already exists"}]}'))
    ).toBe(true);
    expect(bucketReady(400, parseJson('{"errors":[{"message":"nope"}]}'))).toBe(
      false
    );
    expect(httpOk(200)).toBe(true);
    expect(httpOk(409)).toBe(false);
  });
});

describe("backup keys", () => {
  test("names deploy and nightly objects and expires old ones", () => {
    expect(backupPrefix("deploy")).toBe("deploy");
    expect(backupPrefix("nightly")).toBe("nightly");
    expect(backupPrefix("other")).toBeUndefined();
    expect(backupKey("nightly", "2026-10-19T01:02:03.000Z", "abc")).toBe(
      "nightly/2026-10-19.json"
    );
    expect(backupKey("deploy", "2026-10-19T14:56:00.000Z", "abc")).toBe(
      "deploy/20261019T145600Z-abc.json"
    );
    expect(backupKey("deploy", "2026-10-19T14:56:00.123Z", "abc")).toBe(
      "deploy/20261019T145600.123Z-abc.json"
    );
    const day = Date.parse("2026-09-01T00:00:00Z");
    const keys = [
      "nightly/2026-09-01.json",
      "notes/keep",
      "deploy/2026-09-01T1",
    ];
    expect(keyTime("nightly/2026-09-01.json")).toBe(day);
    expect(keyTime("deploy/2026-09-01T010000Z-abc.json")).toBe(day);
    expect(keyTime("notes/keep")).toBeUndefined();
    expect(expiredKeys(keys, day + 30 * 86_400_000, 30)).toEqual([]);
    expect(expiredKeys(keys, day + 30 * 86_400_000 + 1, 30)).toEqual([
      "nightly/2026-09-01.json",
      "deploy/2026-09-01T1",
    ]);
    expect(
      objectKeys(parseJson('{"result":[{"key":"a"},{"size":1}]}'))
    ).toEqual(["a"]);
    expect(objectKeys(parseJson("{}"))).toEqual([]);
  });

  test("reads a workers.dev script name", () => {
    expect(scriptNameFromUrl("https://api.example.workers.dev/mcp")).toBe(
      "api"
    );
    expect(scriptNameFromUrl("https://rooms.example")).toBeUndefined();
    expect(scriptNameFromUrl("not a url")).toBeUndefined();
    expect(scriptNameFromUrl("https://.workers.dev")).toBeUndefined();
  });
});

describe("tools and transcripts", () => {
  test("reads tool text and stitches pages", () => {
    const ok = parseJson(
      '{"result":{"content":[{"text":"{\\"messages\\":[{\\"seq\\":1}]}"}],"isError":false}}'
    );
    expect(toolFailed(ok)).toBe(false);
    expect(toolText(ok)).toContain("messages");
    expect(toolText(parseJson("{}"))).toBeUndefined();
    const streamed = readPayload(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"members\\":[{\\"agentId\\":\\"agent_a\\",\\"displayName\\":\\"ada\\",\\"joined\\":true,\\"kind\\":\\"agent\\",\\"lastReadSeq\\":4,\\"role\\":\\"lead\\"}]}"}],"isError":false}}\n\n'
    );
    expect(memberList(streamed)).toEqual([
      {
        agentId: "agent_a",
        displayName: "ada",
        joined: true,
        kind: "agent",
        lastReadSeq: 4,
        role: "lead",
      },
    ]);
    expect(readPayload("event: message\ndata: \n")).toEqual({ success: false });
    expect(toolFailed(parseJson('{"result":{"isError":true}}'))).toBe(true);
    expect(
      stitchTranscript([
        '{"messages":[{"seq":1}]}',
        '{"messages":[{"seq":2}]}',
        "not-json-wait",
        '{"room":"n"}',
      ])
    ).toBe('[{"seq":1},{"seq":2}]');
  });
});

describe("backup diff", () => {
  test("reports ids and counts without message bodies", () => {
    const before = backup(
      [room("room_a"), room("room_gone")],
      [agent("agent_a", "ada"), agent("agent_gone")]
    );
    const after = backup(
      [
        room("room_a", {
          leadId: "agent_b",
          memberCount: 2,
          members: [
            {
              agentId: "agent_a",
              displayName: "ada",
              joined: false,
              kind: "human",
              lastReadSeq: 4,
              role: "member",
            },
            {
              agentId: "agent_new",
              displayName: "neo",
              joined: true,
              kind: "agent",
              lastReadSeq: 0,
              role: "lead",
            },
          ],
          messageCount: 2,
          name: "renamed",
          topic: "other",
          transcript: '[{"body":"AFTER"}]',
        }),
        room("room_new"),
      ],
      [agent("agent_a", "changed", "human", true), agent("agent_new")]
    );
    const lines = compareBackups(before, after);
    expect(lines).toContain("agent agent_gone missing after deploy");
    expect(lines).toContain("agent agent_new appeared after deploy");
    expect(lines).toContain("agent agent_a identity differs");
    expect(lines).toContain("room room_gone missing after deploy");
    expect(lines).toContain("room room_new appeared after deploy");
    expect(lines).toContain("room room_a messageCount 1 -> 2");
    expect(lines).toContain("room room_a memberCount 1 -> 2");
    expect(lines).toContain("room room_a transcript differs");
    expect(lines).toContain("room room_a name or lead differs");
    expect(lines).toContain("room room_a topic differs");
    expect(lines).toContain(
      "room room_a member agent_a cursor or role differs"
    );
    expect(lines).toContain("room room_a member agent_new appeared");
    expect(lines.join("\n")).not.toContain("SECRET_BODY");
    expect(lines.join("\n")).not.toContain("AFTER");
    expect(compareBackups(before, before)).toEqual([]);
  });

  test("reports a missing member", () => {
    const before = backup([room("room_a")]);
    const after = backup([room("room_a", { memberCount: 0, members: [] })]);
    expect(roomDiff(before.rooms, after.rooms)).toContain(
      "room room_a member agent_a missing"
    );
    expect(agentDiff([agent("agent_a")], [agent("agent_a")])).toEqual([]);
  });
});

describe("worker versions", () => {
  test("picks the newest full deployment", () => {
    const payload = parseJson(
      '{"result":{"deployments":[{"created_on":"2026-10-18T00:00:00Z","versions":[{"percentage":100,"version_id":"old"}]},{"created_on":"2026-10-19T00:00:00Z","versions":[{"percentage":50,"version_id":"half"},{"percentage":"nope"}]},{"nope":true}]}}'
    );
    const rows = deploymentRows(payload);
    expect(rows).toHaveLength(2);
    expect(liveVersionId(rows)).toBeUndefined();
    expect(
      liveVersionId([
        {
          createdOn: "2026-10-19T00:00:00Z",
          versions: [{ percentage: 100, versionId: "live" }],
        },
        {
          createdOn: "2026-10-18T00:00:00Z",
          versions: [{ percentage: 100, versionId: "old" }],
        },
      ])
    ).toBe("live");
    expect(liveVersionId([])).toBeUndefined();
    expect(deploymentRows(parseJson("{}"))).toEqual([]);
  });
});

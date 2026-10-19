import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  configFromEnv,
  execute,
  type GuardConfig,
  type GuardIo,
  runBackup,
  runPin,
  runRollback,
  runVerify,
  workerScript,
} from "../scripts/deploy-guard.ts";
import type { AppCall, CfCall, FetchLike } from "../scripts/http-text.ts";
import { requestHeaders, textRequestWith } from "../scripts/http-text.ts";
import {
  createdAgent,
  failureCode,
  parseBackup,
  roomIdIn,
  toolCall,
  transcriptPage,
  whoamiName,
} from "../scripts/room-parse.ts";
import { authProblems, readBackup, readPages } from "../scripts/room-read.ts";
import { type Json, readPayload } from "../scripts/snapshot-diff.ts";

const ok = (text: string, status = 200) => Promise.resolve({ status, text });

const rpc = (text: string, isError = false) =>
  JSON.stringify({
    result: { content: [{ text, type: "text" }], isError },
  });

const member = {
  agentId: "agent_a",
  displayName: "ada",
  joined: true,
  kind: "agent",
  lastReadSeq: 1,
  role: "lead",
};

const agent = {
  admin: true,
  agentId: "agent_a",
  displayName: "ada",
  kind: "human",
};

const roomId = `room_${"ab".repeat(12)}`;

const launchHead = () =>
  JSON.stringify([
    { leadId: "agent_a", name: "launch", roomId, topic: "ship" },
  ]);

const includes = (body: string | undefined, needle: string) =>
  body?.includes(needle) === true;

const directory = (path: string): ReturnType<typeof ok> | undefined => {
  if (path === "/admin/agents") {
    return ok(JSON.stringify([agent]));
  }
  if (path === "/api/rooms") {
    return ok(launchHead());
  }
  return undefined;
};

const whoami = (path: string): ReturnType<typeof ok> | undefined => {
  if (path === "/api/whoami") {
    return ok('{"displayName":"ada"}');
  }
  return undefined;
};

const transcriptBody = (
  body: string | undefined
): ReturnType<typeof ok> | undefined => {
  if (includes(body, '"name":"members"')) {
    return ok(rpc(JSON.stringify({ members: [member] })));
  }
  if (includes(body, '"since":0')) {
    return ok(transcriptTool(200, 1, 200));
  }
  return undefined;
};

const quietBody = (path: string) => {
  if (path === "/admin/agents" || path === "/api/rooms") {
    return "[]";
  }
  if (path === "/api/whoami") {
    return '{"displayName":"ada"}';
  }
  return "{}";
};

const transcriptTool = (count: number, start: number, next: number | null) =>
  rpc(
    JSON.stringify({
      format: "json",
      nextCursor: next,
      text: JSON.stringify({
        messages: Array.from({ length: count }, (_, index) => ({
          body: "SECRET_BODY",
          seq: start + index,
        })),
        roomName: "launch",
      }),
    })
  );

describe("room backup", () => {
  test("parses tools and a stored backup", () => {
    const payload = readPayload(
      rpc(
        JSON.stringify({
          format: "json",
          nextCursor: 2,
          text: '{"messages":[{"seq":1},{"seq":2}]}',
        })
      )
    );
    expect(transcriptPage(payload)?.count).toBe(2);
    expect(whoamiName(readPayload('{"displayName":"ada"}'))).toBe("ada");
    expect(failureCode(readPayload(rpc('{"code":"NotMember"}', true)))).toBe(
      "NotMember"
    );
    expect(failureCode(readPayload('{"result":{"isError":true}}'))).toBe(
      "tool failed"
    );
    expect(roomIdIn(`created ${roomId}`)).toBe(roomId);
    expect(roomIdIn("none")).toBeUndefined();
    expect(
      createdAgent(JSON.stringify({ agent, token: "sekret" }))?.token
    ).toBe("sekret");
    expect(createdAgent("{}")).toBeUndefined();
    expect(toolCall(1, "members", { room: roomId })).toContain("members");
    const stored = JSON.stringify({
      agents: [agent],
      rooms: [
        {
          ...member,
          leadId: "agent_a",
          memberCount: 1,
          members: [member],
          messageCount: 1,
          name: "launch",
          roomId,
          topic: "ship",
          transcript: '[{"seq":1}]',
        },
      ],
      takenAt: "2026-10-19T00:00:00.000Z",
      version: 1,
    });
    expect(parseBackup(stored).rooms[0]?.roomId).toBe(roomId);
    expect(() => parseBackup("not json")).toThrow("version 1");
    expect(() => parseBackup('{"version":2}')).toThrow("version 1");
    expect(() => parseBackup('{"version":1}')).toThrow("missing rooms");
  });

  test("reads every page without marking a cursor", async () => {
    const paths: string[] = [];
    const http: AppCall = (method, path, _token, body) => {
      paths.push(`${method} ${path} ${body ?? ""}`);
      const listed = directory(path) ?? whoami(path);
      if (listed !== undefined) {
        return listed;
      }
      const page = transcriptBody(body);
      if (page !== undefined) {
        return page;
      }
      expect(body).toContain('"since":200');
      return ok(transcriptTool(1, 201, null));
    };
    const backup = await readBackup(
      http,
      "admin-token",
      "2026-10-19T00:00:00.000Z"
    );
    expect(backup.rooms[0]?.messageCount).toBe(201);
    expect(backup.rooms[0]?.transcript).toContain("SECRET_BODY");
    expect(paths.some((item) => item.includes("read_messages"))).toBe(false);
    expect(await authProblems(http, "admin-token", "admin")).toEqual([]);
    const denied: AppCall = () => ok("", 401);
    expect(await authProblems(denied, "token", "brobert")).toEqual([
      "brobert whoami 401",
    ]);
    const nameless: AppCall = () => ok('{"displayName":""}');
    expect(await authProblems(nameless, "token", "codex")).toEqual([
      "codex whoami omitted displayName",
    ]);
  });

  test("fails closed when a tool or list is incomplete", async () => {
    const agentsDown: AppCall = () => ok("nope", 500);
    await expect(readBackup(agentsDown, "t", "now")).rejects.toThrow(
      "admin agents 500"
    );
    const roomsDown: AppCall = (_method, path) =>
      ok(
        path === "/admin/agents" ? "[]" : "nope",
        path === "/admin/agents" ? 200 : 500
      );
    await expect(readBackup(roomsDown, "t", "now")).rejects.toThrow(
      "rooms 500"
    );
    const badList: AppCall = () => ok("{}");
    await expect(readBackup(badList, "t", "now")).rejects.toThrow(
      "omitted an id"
    );
    const toolDown: AppCall = (_method, path) =>
      directory(path) ?? ok(rpc('{"code":"NotMember"}', true));
    await expect(readBackup(toolDown, "t", "now")).rejects.toThrow(
      `room ${roomId} members NotMember`
    );
    const short: AppCall = () => ok(transcriptTool(1, 1, null));
    const page = await readPages(short, "t", roomId, 3);
    expect(page.pages).toHaveLength(1);
  });
});

const config = (patch: Partial<GuardConfig> = {}): GuardConfig => ({
  account: "acc",
  admin: "admin-token",
  brobert: "brobert-token",
  bucket: "backups",
  codex: "codex-token",
  file: "backup.json",
  prefix: "deploy",
  sha: "abc",
  url: "https://api.example.workers.dev",
  versionFile: "version.txt",
  worker: "api",
  ...patch,
});

const io = (
  call: CfCall,
  http: AppCall,
  files: { [key: string]: string } = {}
): GuardIo & { readonly logs: string[]; readonly errs: string[] } => {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    call,
    err: (line) => {
      errs.push(line);
    },
    errs,
    http,
    log: (line) => {
      logs.push(line);
    },
    logs,
    nowIso: () => "2026-10-19T14:56:00.000Z",
    nowMs: () => Date.parse("2026-10-19T00:00:00Z"),
    readFile: (path) => files[path] ?? "",
    writeFile: (path, body) => {
      files[path] = body;
    },
  };
};

const quietHttp: AppCall = (_method, path) => ok(quietBody(path));

describe("deploy guard", () => {
  test("stores a backup without logging the body", async () => {
    const files: { [key: string]: string } = {};
    const call: CfCall = (method) => {
      if (method === "GET") {
        return ok('{"success":true,"result":[]}');
      }
      return ok('{"success":true}');
    };
    const guard = io(call, quietHttp, files);
    await runBackup(config(), guard);
    expect(guard.logs[0]).toContain("stored deploy/20261019T145600Z-abc.json");
    expect(guard.logs.join("\n")).not.toContain("SECRET_BODY");
    expect(files["backup.json"]).toContain('"version":1');
    await expect(runBackup(config({ prefix: "side" }), guard)).rejects.toThrow(
      "BACKUP_PREFIX"
    );
    await expect(
      runBackup(config({ account: undefined }), guard)
    ).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID");
  });

  test("pins a version and rolls it back", async () => {
    const files: { [key: string]: string } = {};
    const call: CfCall = (method) =>
      ok(
        method === "GET"
          ? '{"success":true,"result":{"deployments":[{"created_on":"2026-10-19T00:00:00Z","versions":[{"percentage":100,"version_id":"ver-live"}]}]}}'
          : "{}"
      );
    const guard = io(call, quietHttp, files);
    await runPin(config(), guard);
    expect(files["version.txt"]).toBe("ver-live");
    expect(guard.logs.at(-1)).toBe("pinned ver-live");
    await runRollback(config(), guard);
    expect(guard.logs.at(-1)).toBe("rolled back to ver-live");
    files["version.txt"] = "  ";
    await expect(runRollback(config(), guard)).rejects.toThrow(
      "no previous worker version"
    );
    const none: CfCall = () => ok("", 404);
    await runPin(config(), io(none, quietHttp, files));
    expect(files["version.txt"]).toBe("");
    await expect(
      runPin(config({ url: "https://rooms.example", worker: undefined }), guard)
    ).rejects.toThrow("AGENT_ROOMS_WORKER_NAME");
  });

  test("verifies tokens and fails with a body-free diff", async () => {
    const stored = JSON.stringify({
      agents: [],
      rooms: [],
      takenAt: "2026-10-19T00:00:00.000Z",
      version: 1,
    });
    const files = { "backup.json": stored };
    const guard = io(() => ok("{}"), quietHttp, files);
    await runVerify(config(), guard);
    expect(guard.logs.at(-1)).toBe("verified rooms=0 agents=0");
    files["backup.json"] = JSON.stringify({
      agents: [agent],
      rooms: [],
      takenAt: "2026-10-19T00:00:00.000Z",
      version: 1,
    });
    const denied: AppCall = (method, path) => {
      if (path === "/api/whoami") {
        return ok("", 401);
      }
      return quietHttp(method, path, "token");
    };
    const again = io(() => ok("{}"), denied, files);
    await expect(runVerify(config(), again)).rejects.toThrow(
      "verification failed"
    );
    expect(again.errs).toContain("agent agent_a missing after deploy");
    expect(again.errs).toContain("admin whoami 401");
    expect(again.errs.join("\n")).not.toContain("SECRET_BODY");
    await expect(execute("nope", config(), guard)).rejects.toThrow("usage");
    await execute("verify", config({ file: "backup.json" }), {
      ...guard,
      http: quietHttp,
      readFile: () => stored,
    });
  });

  test("reads worker names and environment defaults", () => {
    expect(workerScript("https://api.example.workers.dev", undefined)).toBe(
      "api"
    );
    expect(workerScript("https://rooms.example", "Api")).toBe("Api");
    expect(workerScript("", undefined)).toBeUndefined();
    const env = configFromEnv({
      AGENT_ROOMS_URL: "https://api.example.workers.dev",
      CLOUDFLARE_ACCOUNT_ID: "",
    });
    expect(env.bucket).toBe("agent-rooms-nadir-backups");
    expect(env.worker).toBe("api");
    expect(env.account).toBeUndefined();
  });

  test("request headers omit a content type until one is set", async () => {
    expect(requestHeaders("", undefined).authorization).toBeUndefined();
    expect(requestHeaders("token", "application/json")["content-type"]).toBe(
      "application/json"
    );
    const seen: Json[] = [];
    const fetchLike: FetchLike = (_url, init) => {
      seen.push(readPayload(JSON.stringify({ body: init.body ?? null })));
      return Promise.resolve({
        status: 204,
        text: () => Promise.resolve(""),
      });
    };
    await textRequestWith(fetchLike, "GET", "https://example", "");
    await textRequestWith(
      fetchLike,
      "PUT",
      "https://example",
      "token",
      "body",
      "application/json"
    );
    expect(seen[0]).toEqual({ body: null });
    expect(seen[1]).toEqual({ body: "body" });
  });
});

describe("workflows", () => {
  test("deploys from actions and keeps backups off the log", () => {
    const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
    const nightly = readFileSync(".github/workflows/backup.yml", "utf8");
    expect(deploy).not.toContain("upload-artifact");
    expect(deploy).not.toContain("AGENT_ROOMS_LOCAL_STATE");
    expect(deploy).not.toContain("cat ");
    expect(nightly).not.toContain("upload-artifact");
    expect(nightly).not.toContain("cat ");
    const order = [
      "deploy-guard.ts backup",
      "deploy-guard.ts pin",
      "deploy -- --yes --stage nadir",
      "deploy-guard.ts verify",
      "deploy-guard.ts rollback",
      "conformance.ts",
      "live-e2e.ts",
      "wake-receiver.ts down",
    ];
    let at = -1;
    for (const step of order) {
      const next = deploy.indexOf(step);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(deploy).toContain("workflow_dispatch:");
    expect(deploy).toContain("branches: [main]");
    expect(deploy).toContain("environment: nadir");
    expect(deploy).toContain("group: agent-rooms-nadir");
    expect(deploy).toContain("steps.deploy.outcome == 'failure'");
    expect(deploy).toContain("steps.verify.outcome == 'failure'");
    expect(nightly).toContain('cron: "15 7 * * *"');
    expect(nightly).toContain("AGENT_ROOMS_BACKUP_PREFIX: nightly");
    expect(nightly).toContain("group: agent-rooms-nadir");
    expect(nightly).not.toContain("bun run deploy");
  });
});

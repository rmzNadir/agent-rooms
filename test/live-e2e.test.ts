import { describe, expect, test } from "bun:test";
import { conformanceSummary } from "../scripts/conformance.ts";
import type { FetchLike } from "../scripts/http-text.ts";
import {
  continuesAt,
  cursorAdvanced,
  deliveryOk,
  healthOk,
  liveNames,
  mentionRejected,
  openedAtZero,
  pauseCount,
  untilStatus,
  viewerReady,
  waitUntil,
  wakeBodies,
  wakeNumber,
} from "../scripts/live-checks.ts";
import {
  healthAndViewer,
  type LiveIo,
  liveIo,
  runLive,
} from "../scripts/live-e2e.ts";
import { readPayload, textField } from "../scripts/snapshot-diff.ts";
import {
  receiverForm,
  receiverMetadata,
  receiverName,
  uploadScript,
} from "../scripts/wake-receiver.ts";
import { readEnv, writeEnv } from "../src/boundary/external.ts";
import { restoreEnv } from "./restore-env.ts";

const roomId = `room_${"ab".repeat(12)}`;

const rpc = (text: string, isError = false) =>
  JSON.stringify({
    result: { content: [{ text, type: "text" }], isError },
  });

const sent = (text: string, status = 200) => Promise.resolve({ status, text });

const wake = (fromSeq: number, toSeq: number) =>
  JSON.stringify({
    deliveryId: "dlv_abc",
    fromSeq,
    sinceCursor: fromSeq,
    toSeq,
  });

type MutableLive = {
  -readonly [Key in keyof LiveIo]: LiveIo[Key];
};

interface LiveState {
  agents: number;
  hops: number;
  wakePosts: number;
}

const has = (body: string | undefined, needle: string) =>
  body?.includes(needle) === true;

const page = (path: string): ReturnType<typeof sent> | undefined => {
  if (path === "/health") {
    return sent('{"ok":true}');
  }
  if (path === "/") {
    return sent("agent-rooms Bearer token");
  }
  return undefined;
};

const wakeList = (posts: number) => {
  const bodies: string[] = [];
  if (posts >= 1) {
    bodies.push(wake(0, 4));
  }
  if (posts >= 2) {
    bodies.push(wake(4, 5));
  }
  return bodies;
};

const recorded = (
  path: string,
  posts: number
): ReturnType<typeof sent> | undefined => {
  if (path !== "/wakes") {
    return undefined;
  }
  return sent(JSON.stringify(wakeList(posts)));
};

const opened = (path: string, posts: number) =>
  page(path) ?? recorded(path, posts);

const minted = (
  method: string,
  path: string,
  body: string | undefined,
  state: LiveState
): ReturnType<typeof sent> | undefined => {
  if (path !== "/admin/agents") {
    return undefined;
  }
  if (method !== "POST") {
    return undefined;
  }
  state.agents += 1;
  const displayName = textField(readPayload(body ?? ""), "displayName");
  return sent(
    JSON.stringify({
      agent: { agentId: `agent_${state.agents}`, displayName },
      token: `tok${state.agents}`,
    })
  );
};

const roomTool = (body: string | undefined): string | undefined => {
  if (has(body, '"name":"create_room"')) {
    return rpc(JSON.stringify({ roomId }));
  }
  if (has(body, '"name":"list_rooms"')) {
    return rpc(roomId);
  }
  return undefined;
};

const ping = (state: LiveState) => {
  state.hops += 1;
  if (state.hops > 20) {
    return rpc("paused after 20", true);
  }
  return rpc('{"ok":true}');
};

const wave = (
  body: string | undefined,
  state: LiveState
): string | undefined => {
  if (has(body, '"body":"one ')) {
    state.wakePosts = 1;
    return rpc('{"ok":true}');
  }
  if (has(body, '"body":"two ')) {
    state.wakePosts = 2;
    return rpc('{"ok":true}');
  }
  return undefined;
};

const postTool = (body: string | undefined, state: LiveState) => {
  if (has(body, '"body":"hello"')) {
    return rpc('{"code":"MentionRequired"}', true);
  }
  if (has(body, '"body":"ping')) {
    return ping(state);
  }
  return wave(body, state);
};

const memberTool = (hook: string) =>
  rpc(
    JSON.stringify({
      members: [
        {
          agentId: "agent_4",
          displayName: hook,
          joined: true,
          kind: "agent",
          lastReadSeq: 4,
          role: "member",
        },
      ],
    })
  );

const readTool = (
  body: string | undefined,
  hook: string
): string | undefined => {
  if (has(body, '"name":"get_unread"')) {
    return rpc('{"lastReadSeq":1}');
  }
  if (has(body, '"name":"read_messages"')) {
    return rpc("status");
  }
  if (has(body, '"name":"members"')) {
    return memberTool(hook);
  }
  return undefined;
};

const toolBody = (body: string | undefined, hook: string, state: LiveState) => {
  const rooms = roomTool(body);
  if (rooms !== undefined) {
    return rooms;
  }
  const posted = postTool(body, state);
  if (posted !== undefined) {
    return posted;
  }
  return readTool(body, hook);
};

const scripted = (closeCode: number) => {
  const names = liveNames("abc123");
  const state: LiveState = { agents: 0, hops: 0, wakePosts: 0 };
  let downed = false;
  const request: LiveIo["request"] = (method, url, _token, body) => {
    const path = new URL(url).pathname;
    const direct = opened(path, state.wakePosts);
    if (direct !== undefined) {
      return direct;
    }
    const made = minted(method, path, body, state);
    if (made !== undefined) {
      return made;
    }
    const tool = toolBody(body, names.hook, state);
    if (tool !== undefined) {
      return sent(tool);
    }
    return sent(rpc('{"ok":true}'));
  };
  const io: MutableLive = {
    admin: "admin-token",
    base: "https://rooms.example",
    down: () => {
      downed = true;
      return Promise.resolve();
    },
    now: () => 0,
    request,
    sleep: () => Promise.resolve(),
    socket: () =>
      Promise.resolve({
        closeCode: Promise.resolve(closeCode),
        opened: Promise.resolve(),
      }),
    suffix: "abc123",
    up: () => Promise.resolve("https://receiver.example.workers.dev"),
  };
  return {
    downed: () => downed,
    io,
    names,
  };
};

describe("live checks", () => {
  test("classifies health, mentions, pauses, and wakes", () => {
    expect(healthOk(200, '{"ok":true}')).toBe(true);
    expect(healthOk(500, '{"ok":true}')).toBe(false);
    expect(viewerReady("agent-rooms Bearer token")).toBe(true);
    expect(viewerReady("agent-rooms")).toBe(false);
    expect(mentionRejected('{"code":"MentionRequired","isError":true}')).toBe(
      true
    );
    expect(mentionRejected('{"code":"MentionRequired"}')).toBe(false);
    expect(mentionRejected('{"isError":true}')).toBe(false);
    expect(pauseCount(["ok", "paused after 20", "paused after 20"])).toBe(2);
    expect(cursorAdvanced('{"lastReadSeq\\":1}')).toBe(true);
    expect(cursorAdvanced('{"lastReadSeq\\":0}')).toBe(false);
    expect(wakeBodies('[1, "hi"]')).toEqual(["hi"]);
    expect(wakeBodies("{}")).toEqual([]);
    expect(openedAtZero(wake(0, 2))).toBe(true);
    expect(deliveryOk(wake(0, 2))).toBe(true);
    expect(deliveryOk('{"deliveryId":"nope"}')).toBe(false);
    expect(continuesAt(wake(2, 3), 2)).toBe(true);
    expect(wakeNumber("not json", "toSeq")).toBeUndefined();
    expect(liveNames("abc123").left).toBe("e2eaabc123");
    expect(liveNames("!!!").human).toBe("e2ehrun");
  });

  test("stops waiting at the count or the deadline", async () => {
    let clock = 0;
    const ready = await waitUntil(
      () => Promise.resolve(["one"]),
      1,
      () => clock,
      () => {
        clock += 200;
        return Promise.resolve();
      }
    );
    expect(ready).toEqual(["one"]);
    const late = await waitUntil(
      () => Promise.resolve([]),
      1,
      () => 20_000,
      () => Promise.resolve()
    );
    expect(late).toEqual([]);
    expect(
      await untilStatus(
        () => Promise.resolve(200),
        200,
        () => 0,
        () => Promise.resolve()
      )
    ).toBe(true);
    expect(
      await untilStatus(
        () => Promise.resolve(500),
        200,
        () => 20_000,
        () => Promise.resolve()
      )
    ).toBe(false);
  });
});

describe("live suite", () => {
  test("runs health, hops, and a wake against a scripted worker", async () => {
    const live = scripted(1000);
    await runLive(live.io);
    expect(live.downed()).toBe(true);
  });

  test("deletes the receiver when a later check fails", async () => {
    const live = scripted(1000);
    live.io.request = (_method, url) => {
      if (new URL(url).pathname === "/health") {
        return sent("down", 500);
      }
      return sent("{}");
    };
    await expect(runLive(live.io)).rejects.toThrow("health 500");
    expect(live.downed()).toBe(true);
    const closed = scripted(4400);
    await expect(
      healthAndViewer({
        ...closed.io,
        request: () => sent("agent-rooms Bearer token"),
      })
    ).rejects.toThrow("health 200");
  });

  test("does not delete a receiver that never opened", async () => {
    const live = scripted(1000);
    live.io.up = () => Promise.reject(new Error("upload failed"));
    await expect(runLive(live.io)).rejects.toThrow("upload failed");
    expect(live.downed()).toBe(false);
  });

  test("builds the throwaway receiver and refuses a failed upload", async () => {
    expect(receiverName("12")).toBe("agent-rooms-receiver-12");
    expect(JSON.stringify(receiverMetadata())).toContain(
      "durable_object_namespace"
    );
    const form = receiverForm();
    const metadata = form.get("metadata");
    expect(metadata).toBeInstanceOf(File);
    if (metadata instanceof File) {
      expect(await metadata.text()).toContain(
        '"migrations":{"new_sqlite_classes":["Wakes"],"new_tag":"v1"}'
      );
    }
    const fetchLike: FetchLike = () =>
      Promise.resolve({
        status: 500,
        text: () => Promise.resolve("SECRET_BODY"),
      });
    await expect(
      uploadScript(fetchLike, "token", "acc", "receiver")
    ).rejects.toThrow("receiver upload failed 500 cloudflare request failed");
  });

  test("upload names the cloudflare error and skips the body", async () => {
    const fetchLike: FetchLike = () =>
      Promise.resolve({
        status: 400,
        text: () =>
          Promise.resolve(
            '{"errors":[{"code":10021,"message":"migrations must be an object"}],"SECRET_BODY":"nope"}'
          ),
      });
    const failed = await uploadScript(
      fetchLike,
      "token",
      "acc",
      "receiver"
    ).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : "")
    );
    expect(failed).toBe(
      "receiver upload failed 400 10021 migrations must be an object"
    );
    expect(failed).not.toContain("SECRET_BODY");
  });

  test("conformance names the versions that passed", () => {
    expect(conformanceSummary(["2026-07-28", "2025-06-18"])).toBe(
      "conformance passed 2026-07-28 2025-06-18"
    );
  });

  test("liveIo uses the worker url without a trailing slash", () => {
    const keys = [
      "AGENT_ROOMS_URL",
      "AGENT_ROOMS_ADMIN_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
    ];
    const previous = keys.map((key) => readEnv(key));
    writeEnv("AGENT_ROOMS_URL", "https://rooms.example/");
    writeEnv("AGENT_ROOMS_ADMIN_TOKEN", "admin-token");
    writeEnv("CLOUDFLARE_API_TOKEN", "cf-token");
    writeEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
    writeEnv("GITHUB_RUN_ATTEMPT", "2");
    writeEnv("GITHUB_RUN_ID", "12");
    const io = liveIo();
    expect(io.base).toBe("https://rooms.example");
    expect(io.suffix).toBe("212");
    keys.forEach((key, index) => {
      restoreEnv(key, previous[index]);
    });
  });
});

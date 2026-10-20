import { describe, expect, test } from "bun:test";
import {
  type AppCall,
  appFetchWith,
  backoffMs,
  type FetchLike,
  READ_TIMEOUT_MS,
  readOnly,
  retryRead,
  textRequestWith,
  transportFailure,
} from "../scripts/http-text.ts";
import { toolCall } from "../scripts/room-parse.ts";
import { readBackup } from "../scripts/room-read.ts";

const sleep = () => Promise.resolve();

const reply = (status: number, text = "") => Promise.resolve({ status, text });

const reset = (
  message = "ECONNRESET: The socket connection was closed unexpectedly"
) => Object.assign(new Error(message), { cause: { code: "ECONNRESET" } });

describe("read retry", () => {
  test("classifies read only calls and transport failures", () => {
    expect(readOnly("GET", "/api/rooms")).toBe(true);
    expect(readOnly("GET", "/admin/agents")).toBe(true);
    expect(readOnly("GET", "/api/whoami")).toBe(true);
    expect(readOnly("GET", "/health")).toBe(false);
    expect(readOnly("POST", "/mcp", toolCall(1, "members", {}))).toBe(true);
    expect(readOnly("POST", "/mcp", toolCall(1, "read_transcript", {}))).toBe(
      true
    );
    expect(readOnly("POST", "/mcp", toolCall(1, "whoami", {}))).toBe(true);
    expect(
      readOnly("POST", "/mcp", toolCall(1, "post_message", { text: "hi" }))
    ).toBe(false);
    expect(readOnly("PUT", "/api/rooms", "{}")).toBe(false);
    expect(backoffMs(1)).toBe(200);
    expect(backoffMs(2)).toBe(400);
    expect(transportFailure(reset())).toBe(true);
    expect(transportFailure(new Error("ETIMEDOUT"))).toBe(false);
    expect(
      transportFailure(
        Object.assign(new Error("closed"), { name: "TimeoutError" })
      )
    ).toBe(true);
    expect(
      transportFailure(
        Object.assign(new Error("closed"), { cause: { code: "ETIMEDOUT" } })
      )
    ).toBe(true);
    expect(transportFailure(new Error("nope"))).toBe(false);
    expect(transportFailure(new Error("socket connection was closed"))).toBe(
      true
    );
  });

  test("retries a reset and a server error, then stops on a client error", async () => {
    const waits: number[] = [];
    let calls = 0;
    const recovered = await retryRead(
      () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(reset());
        }
        if (calls === 2) {
          return reply(503, "busy");
        }
        return reply(200, "[]");
      },
      (ms) => {
        waits.push(ms);
        return sleep();
      }
    );
    expect(recovered).toEqual({ status: 200, text: "[]" });
    expect(waits).toEqual([200, 400]);
    let failures = 0;
    const last = await retryRead(() => {
      failures += 1;
      return reply(502, "down");
    }, sleep);
    expect(last.status).toBe(502);
    expect(failures).toBe(3);
    let denied = 0;
    const client = await retryRead(() => {
      denied += 1;
      return reply(401, "");
    }, sleep);
    expect(client.status).toBe(401);
    expect(denied).toBe(1);
    await expect(
      retryRead(() => Promise.reject(reset()), sleep)
    ).rejects.toThrow("ECONNRESET");
    await expect(
      retryRead(() => Promise.reject(new Error("nope")), sleep)
    ).rejects.toThrow("nope");
  });

  test("times out reads and does not retry writes", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchLike: FetchLike = (_url, init) => {
      signals.push(init.signal);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve("[]"),
      });
    };
    await textRequestWith(
      fetchLike,
      "GET",
      "https://rooms.example/api/rooms",
      "token",
      undefined,
      "application/json",
      READ_TIMEOUT_MS
    );
    await textRequestWith(
      fetchLike,
      "POST",
      "https://rooms.example/mcp",
      "token",
      toolCall(1, "post_message", {}),
      "application/json"
    );
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeUndefined();
    let writes = 0;
    const failing: FetchLike = (_url, init) => {
      writes += 1;
      signals.push(init.signal);
      return Promise.reject(reset());
    };
    const http = appFetchWith("https://rooms.example", failing);
    await expect(
      http("POST", "/mcp", "token", toolCall(1, "post_message", {}))
    ).rejects.toThrow("ECONNRESET");
    await expect(http("GET", "/api/rooms", "token")).rejects.toThrow(
      "ECONNRESET"
    );
    expect(writes).toBe(2);
    expect(signals.at(-1)).toBeInstanceOf(AbortSignal);
  });

  test("backup reads retry a dropped room list", async () => {
    let rooms = 0;
    const http: AppCall = (_method, path) => {
      if (path === "/admin/agents") {
        return reply(200, "[]");
      }
      if (path === "/api/rooms") {
        rooms += 1;
        if (rooms < 3) {
          return Promise.reject(reset("socket connection was closed"));
        }
        return reply(200, "[]");
      }
      return reply(200, "{}");
    };
    const backup = await readBackup(http, "token", "now");
    expect(rooms).toBe(3);
    expect(backup.rooms).toEqual([]);
    expect(backup.agents).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Json } from "effect/Schema";
import type { ListenerConfig, WakeCall } from "../listeners/listener-io.mjs";
import {
  createLane,
  type PendingRecord,
  readPendingFile,
  writePendingFile,
} from "../listeners/listener-io.mjs";
import { handleWake, resumeUnfinished } from "../listeners/listener-wake.mjs";
import {
  adaConfig,
  rememberSeq,
  untilStarted,
  wakeSeq,
  wakeText,
} from "./listener-values.ts";

const secret = "sek";
const roomId = "room_0123456789abcdef01234567";
const agentId = "agent_0123456789abcdef01234567";

const signed = (payload: Json, now: number) => {
  const body = JSON.stringify(payload);
  const timestamp = String(now);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { body, signature: `sha256=${signature}`, timestamp };
};

const wake = (deliveryId: string, seq: number) => ({
  agentId,
  deliveryId,
  fromSeq: 4,
  hopCount: 1,
  paused: false,
  roomId,
  roomName: "launch",
  sinceCursor: 4,
  toSeq: seq,
  triggeringMessageIds: [`msg_${seq}`],
  youAreLead: true,
});

const harness = () => {
  const started: string[] = [];
  const marks: number[] = [];
  let release:
    | ((result: { status: number; body: { ok: boolean } }) => void)
    | undefined;
  const start = (payload: WakeCall, _config: ListenerConfig, prompt: string) =>
    new Promise<{ status: number; body: { ok: boolean; prompt: string } }>(
      (resolve) => {
        started.push(wakeText(payload.deliveryId));
        release = (result) =>
          resolve({ ...result, body: { ...result.body, prompt } });
      }
    );
  return {
    deps: () => ({
      config: adaConfig(secret),
      lane: createLane(),
      markRead: rememberSeq(marks),
      now: Date.now(),
      seenDeliveries: new Map(),
      seenSignatures: new Map(),
      start,
    }),
    finish: (status = 200) => {
      const current = release;
      release = undefined;
      current?.({ body: { ok: status === 200 }, status });
    },
    marks,
    start,
    started,
  };
};

const postWake = (
  deps: Parameters<typeof handleWake>[1],
  deliveryId: string,
  seq: number,
  now: number
) =>
  handleWake({ method: "POST", ...signed(wake(deliveryId, seq), now) }, deps);

test("acks a verified wake before the harness exits and runs it after", async () => {
  const run = harness();
  const now = Date.now();
  const http = signed(wake("dlv_1", 9), now);
  const response = await handleWake({ method: "POST", ...http }, run.deps());
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ coalesced: false, ok: true });
  expect(run.started).toEqual(["dlv_1"]);
  expect(run.marks).toEqual([]);
  run.finish();
  await response.done;
  expect(run.marks).toEqual([9]);
});

test("one room and agent runs once, and later wakes become a single follow-up", async () => {
  const run = harness();
  const deps = run.deps();
  const now = Date.now();
  const first = await postWake(deps, "dlv_1", 9, now);
  const second = await postWake(deps, "dlv_2", 10, now);
  const third = await postWake(deps, "dlv_3", 11, now);
  expect(second.body).toEqual({ coalesced: true, ok: true });
  expect(third.body).toEqual({ coalesced: true, ok: true });
  expect(run.started).toEqual(["dlv_1"]);
  run.finish();
  await untilStarted(run.started, 2);
  expect(run.started).toEqual(["dlv_1", "dlv_3"]);
  run.finish();
  await first.done;
  expect(run.marks).toEqual([9, 11]);
});

test("a repeated delivery id does not start another run", async () => {
  const run = harness();
  const deps = run.deps();
  const now = Date.now();
  const http = signed(wake("dlv_1", 9), now);
  const first = await handleWake({ method: "POST", ...http }, deps);
  const retry = signed(wake("dlv_1", 9), now + 1);
  const again = await handleWake({ method: "POST", ...retry }, deps);
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ duplicate: true, ok: true });
  expect(run.started).toEqual(["dlv_1"]);
  run.finish();
  await first.done;
});

test("the prompt tells the harness the unseen seq range", async () => {
  const run = harness();
  const now = Date.now();
  let prompt = "";
  const deps = run.deps();
  deps.start = (payload, _config, text) => {
    prompt = text;
    run.started.push(wakeText(payload.deliveryId));
    return Promise.resolve({ body: { ok: true, prompt: text }, status: 200 });
  };
  const response = await handleWake(
    { method: "POST", ...signed(wake("dlv_9", 9), now) },
    deps
  );
  await response.done;
  expect(prompt).toContain("since 4");
  expect(prompt).toContain("seq 9");
});

const pendingDir = () =>
  mkdtempSync(path.join(tmpdir(), "agent-rooms-pending-"));

const failingDeps = (
  dir: string,
  start: (
    wake: WakeCall,
    config: ListenerConfig,
    prompt: string
  ) => Promise<{ status: number; body: { ok: boolean } }>
) => {
  const marks: number[] = [];
  const delays: number[] = [];
  const reports: string[] = [];
  return {
    delays,
    deps: {
      config: adaConfig(secret),
      lane: createLane(),
      markRead: rememberSeq(marks),
      now: Date.now(),
      pendingDir: dir,
      reportFailure: (_config: ListenerConfig, payload: WakeCall) => {
        reports.push(
          `@human I failed to process messages ${payload.fromSeq} through ${payload.toSeq} after 3 attempts.`
        );
        return Promise.resolve(true);
      },
      seenDeliveries: new Map<string, number>(),
      seenSignatures: new Map<string, number>(),
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
      start,
    },
    marks,
    reports,
  };
};

test("the accepted seq range is on disk before the harness runs", async () => {
  const dir = pendingDir();
  let saved: PendingRecord | undefined;
  const run = failingDeps(dir, () => {
    saved = readPendingFile(dir, roomId, agentId);
    return Promise.resolve({ body: { ok: true }, status: 200 });
  });
  const response = await handleWake(
    { method: "POST", ...signed(wake("dlv_disk", 9), Date.now()) },
    run.deps
  );
  expect(response.status).toBe(200);
  expect(saved?.wake?.deliveryId).toBe("dlv_disk");
  expect(saved?.wake?.fromSeq).toBe(4);
  expect(saved?.wake?.toSeq).toBe(9);
  expect(saved?.attempts).toBe(1);
  await response.done;
  expect(run.marks).toEqual([9]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a non-zero harness is retried and mark_read runs once after success", async () => {
  const dir = pendingDir();
  let calls = 0;
  const run = failingDeps(dir, () => {
    calls += 1;
    return Promise.resolve({
      body: { ok: calls >= 3 },
      status: calls < 3 ? 500 : 200,
    });
  });
  const response = await handleWake(
    { method: "POST", ...signed(wake("dlv_retry", 9), Date.now()) },
    run.deps
  );
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ coalesced: false, ok: true });
  await response.done;
  expect(calls).toBe(3);
  expect(run.delays).toEqual([1000, 2000]);
  expect(run.marks).toEqual([9]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a thrown harness is the same as a non-zero exit", async () => {
  const dir = pendingDir();
  let calls = 0;
  const run = failingDeps(dir, () => {
    calls += 1;
    if (calls < 3) {
      return Promise.reject(new Error("harness crashed"));
    }
    return Promise.resolve({ body: { ok: true }, status: 200 });
  });
  const response = await handleWake(
    { method: "POST", ...signed(wake("dlv_throw", 9), Date.now()) },
    run.deps
  );
  await response.done;
  expect(calls).toBe(3);
  expect(run.marks).toEqual([9]);
  expect(run.delays).toEqual([1000, 2000]);
});

test("three failures tell @human and do not mark the range read", async () => {
  const dir = pendingDir();
  let calls = 0;
  const run = failingDeps(dir, () => {
    calls += 1;
    return Promise.resolve({ body: { ok: false }, status: 500 });
  });
  const response = await handleWake(
    { method: "POST", ...signed(wake("dlv_giveup", 9), Date.now()) },
    run.deps
  );
  await response.done;
  expect(calls).toBe(3);
  expect(run.marks).toEqual([]);
  expect(run.reports).toEqual([
    "@human I failed to process messages 4 through 9 after 3 attempts.",
  ]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a failure post that does not land stays pending for the next listener start", async () => {
  const dir = pendingDir();
  let calls = 0;
  let posted = false;
  const run = failingDeps(dir, () => {
    calls += 1;
    return Promise.resolve({ body: { ok: false }, status: 500 });
  });
  run.deps.reportFailure = () => Promise.resolve(posted);
  const response = await handleWake(
    { method: "POST", ...signed(wake("dlv_stuck", 9), Date.now()) },
    run.deps
  );
  await response.done;
  expect(calls).toBe(3);
  const stuck = readPendingFile(dir, roomId, agentId);
  expect(stuck?.attempts).toBe(3);
  expect(stuck?.wake?.toSeq).toBe(9);
  posted = true;
  const resumedStarts: string[] = [];
  await resumeUnfinished(dir, {
    ...run.deps,
    lane: createLane(),
    start: (payload: WakeCall) => {
      resumedStarts.push(wakeText(payload.deliveryId));
      return Promise.resolve({ body: { ok: true }, status: 200 });
    },
  });
  expect(resumedStarts).toEqual([]);
  expect(run.marks).toEqual([]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a listener restart continues a crashed attempt and marks read only after success", async () => {
  const dir = pendingDir();
  writePendingFile(dir, roomId, agentId, {
    attempts: 1,
    followUp: null,
    phase: "running",
    wake: wake("dlv_crash", 9),
  });
  let attemptsDuring = 0;
  const marks: number[] = [];
  await resumeUnfinished(dir, {
    config: adaConfig(),
    lane: createLane(),
    markRead: rememberSeq(marks),
    pendingDir: dir,
    sleep: () => Promise.resolve(),
    start: () => {
      attemptsDuring = readPendingFile(dir, roomId, agentId)?.attempts ?? 0;
      return Promise.resolve({ body: { ok: true }, status: 200 });
    },
  });
  expect(attemptsDuring).toBe(2);
  expect(marks).toEqual([9]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a restart after the last crashed attempt posts @human and does not run the harness", async () => {
  const dir = pendingDir();
  writePendingFile(dir, roomId, agentId, {
    attempts: 3,
    followUp: null,
    phase: "running",
    wake: wake("dlv_last", 9),
  });
  const reports: string[] = [];
  const starts: string[] = [];
  await resumeUnfinished(dir, {
    config: { agentName: "ada" },
    lane: createLane(),
    pendingDir: dir,
    reportFailure: (_config: ListenerConfig, payload: WakeCall) => {
      reports.push(`${payload.fromSeq}-${payload.toSeq}`);
      return Promise.resolve(true);
    },
    sleep: () => Promise.resolve(),
    start: (payload: WakeCall) => {
      starts.push(wakeText(payload.deliveryId));
      return Promise.resolve({ body: { ok: true }, status: 200 });
    },
  });
  expect(starts).toEqual([]);
  expect(reports).toEqual(["4-9"]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a restart after a successful harness only marks the range read", async () => {
  const dir = pendingDir();
  writePendingFile(dir, roomId, agentId, {
    attempts: 2,
    followUp: null,
    phase: "succeeded",
    wake: wake("dlv_done", 9),
  });
  const marks: number[] = [];
  const starts: string[] = [];
  await resumeUnfinished(dir, {
    config: { agentName: "ada" },
    lane: createLane(),
    markRead: (_config: ListenerConfig, payload: WakeCall) => {
      marks.push(wakeSeq(payload.toSeq));
      return Promise.resolve();
    },
    pendingDir: dir,
    sleep: () => Promise.resolve(),
    start: (payload: WakeCall) => {
      starts.push(wakeText(payload.deliveryId));
      return Promise.resolve({ body: { ok: false }, status: 500 });
    },
  });
  expect(starts).toEqual([]);
  expect(marks).toEqual([9]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

test("a wake that arrives during a retry is run after the current range succeeds", async () => {
  const dir = pendingDir();
  const run = harness();
  const deps = {
    ...run.deps(),
    pendingDir: dir,
    sleep: () => Promise.resolve(),
  };
  const now = Date.now();
  const first = await postWake(deps, "dlv_1", 9, now);
  const second = await postWake(deps, "dlv_2", 11, now + 1);
  expect(second.body).toEqual({ coalesced: true, ok: true });
  expect(readPendingFile(dir, roomId, agentId)?.followUp?.deliveryId).toBe(
    "dlv_2"
  );
  run.finish();
  await untilStarted(run.started, 2);
  expect(run.started).toEqual(["dlv_1", "dlv_2"]);
  run.finish();
  await first.done;
  expect(run.marks).toEqual([9, 11]);
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined();
});

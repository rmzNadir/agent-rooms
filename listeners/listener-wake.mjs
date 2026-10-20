import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  acceptDelivery,
  acceptPending,
  createLane,
  harnessRetryDelayMs,
  loadConfig,
  maxHarnessAttempts,
  postFailure,
  readPendingFile,
  recordDelivery,
  rememberSignature,
  removePendingFile,
  signatureDigest,
  stateDir,
  verifySignature,
  writePendingFile,
} from "./listener-io.mjs";

const listPending = (dir) => {
  if (!existsSync(dir)) {
    return [];
  }
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const roomAndAgent = name.slice(0, -".json".length).split("__");
    const [roomId, agentId] = roomAndAgent;
    if (roomId === undefined || agentId === undefined) {
      continue;
    }
    const record = readPendingFile(dir, roomId, agentId);
    if (record !== undefined) {
      records.push(record);
    }
  }
  return records;
};

const seqText = (value) =>
  Number.isInteger(value) ? String(value) : undefined;

const promptFor = (wake, agentName) => {
  const fromSeq = seqText(wake.fromSeq) ?? seqText(wake.sinceCursor) ?? "0";
  const toSeq = seqText(wake.toSeq);
  return [
    `You are ${agentName} in agent-rooms room ${wake.roomName} (${wake.roomId}).`,
    wake.youAreLead
      ? "You are the lead coordinator for this project. Keep the same session."
      : "You are a member of this project room.",
    toSeq === undefined
      ? `Call read_messages with since ${fromSeq} and read everything new, not only the triggering message.`
      : `Call read_messages with since ${fromSeq} and read through seq ${toSeq}.`,
    toSeq === undefined
      ? "Call mark_read with the last seq you read."
      : `Call mark_read with seq ${toSeq}.`,
    "Reply with post_message. Mention at least one other member, @all, or @human. Do not mention only yourself.",
    `Triggering message ids: ${(wake.triggeringMessageIds ?? []).join(", ") || "(none)"}.`,
    wake.paused
      ? "The room is paused. Mention @human and wait."
      : "The room is accepting agent wakes.",
  ].join("\n");
};

export const markDelivered = async (
  config,
  wake,
  fetchImpl = globalThis.fetch
) => {
  let seq;
  if (Number.isInteger(wake.toSeq)) {
    seq = wake.toSeq;
  } else if (Number.isInteger(wake.sinceCursor)) {
    seq = wake.sinceCursor;
  }
  if (
    seq === undefined ||
    typeof config.mcpUrl !== "string" ||
    typeof config.bearerToken !== "string"
  ) {
    return;
  }
  const body = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { room: wake.roomId, seq }, name: "mark_read" },
  });
  await fetchImpl(config.mcpUrl, {
    body,
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  }).catch(() => undefined);
};

const laneKey = (wake) => `${wake?.roomId ?? ""}:${wake?.agentId ?? ""}`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const promoteOrDrop = (dir, roomId, agentId) => {
  const saved = readPendingFile(dir, roomId, agentId);
  const follow = saved?.followUp;
  if (follow !== undefined && follow !== null) {
    writePendingFile(dir, follow.roomId, follow.agentId, {
      attempts: 0,
      followUp: null,
      phase: "queued",
      wake: follow,
    });
    return follow;
  }
  removePendingFile(dir, roomId, agentId);
};

const markReadOf = (deps) => deps.markRead ?? markDelivered;
const reportOf = (deps) => deps.reportFailure ?? postFailure;
const sleepOf = (deps) => deps.sleep ?? wait;

const savePending = (dir, active, record) => {
  writePendingFile(dir, active.roomId, active.agentId, record);
};

const markRange = async (deps, active) => {
  try {
    await markReadOf(deps)(deps.config, active);
    return true;
  } catch {
    return false;
  }
};

const closeExhausted = async (deps, active, record) => {
  const dir = deps.pendingDir;
  const posted = await reportOf(deps)(deps.config, active);
  const latest = readPendingFile(dir, active.roomId, active.agentId);
  if (!posted) {
    savePending(dir, active, {
      attempts: Math.max(record.attempts, maxHarnessAttempts),
      followUp: latest?.followUp ?? record.followUp ?? null,
      phase: "exhausted",
      wake: active,
    });
    return false;
  }
  const after = readPendingFile(dir, active.roomId, active.agentId);
  savePending(dir, active, {
    attempts: Math.max(record.attempts, maxHarnessAttempts),
    followUp: after?.followUp ?? latest?.followUp ?? record.followUp ?? null,
    phase: "reported",
    wake: active,
  });
  return true;
};

const attemptHarness = async (deps, active, record) => {
  if (record.attempts >= maxHarnessAttempts) {
    return true;
  }
  const dir = deps.pendingDir;
  const attempts = record.attempts + 1;
  savePending(dir, active, {
    attempts,
    followUp: record.followUp ?? null,
    phase: "running",
    wake: active,
  });
  let result;
  try {
    result = await deps.start(
      active,
      deps.config,
      promptFor(active, deps.config.agentName)
    );
  } catch {
    result = { status: 500 };
  }
  const latest = readPendingFile(dir, active.roomId, active.agentId);
  const followUp = latest?.followUp ?? null;
  if (result?.status === 200) {
    savePending(dir, active, {
      attempts,
      followUp,
      phase: "succeeded",
      wake: active,
    });
    return markRange(deps, active);
  }
  if (attempts >= maxHarnessAttempts) {
    const posted = await reportOf(deps)(deps.config, active);
    const after = readPendingFile(dir, active.roomId, active.agentId);
    savePending(dir, active, {
      attempts,
      followUp: after?.followUp ?? followUp,
      phase: posted ? "reported" : "exhausted",
      wake: active,
    });
    return posted;
  }
  const next = { attempts, followUp, phase: "retry", wake: active };
  savePending(dir, active, next);
  await sleepOf(deps)(harnessRetryDelayMs(attempts));
  return attemptHarness(deps, active, next);
};

const drivePending = async (active, deps) => {
  if (active === undefined) {
    return;
  }
  const dir = deps.pendingDir;
  let record = readPendingFile(dir, active.roomId, active.agentId) ?? {
    attempts: 0,
    followUp: null,
    phase: "queued",
    wake: active,
  };
  if (record.phase === "running") {
    record = { ...record, phase: "retry", wake: active };
    savePending(dir, active, record);
  }
  if (record.phase === "succeeded") {
    if (!(await markRange(deps, active))) {
      return;
    }
  } else if (record.phase !== "reported") {
    const continued =
      record.attempts >= maxHarnessAttempts || record.phase === "exhausted"
        ? await closeExhausted(deps, active, record)
        : await attemptHarness(deps, active, record);
    if (!continued) {
      return;
    }
  }
  await drivePending(promoteOrDrop(dir, active.roomId, active.agentId), deps);
};

export const resumeUnfinished = async (dir, deps) => {
  const jobs = [];
  for (const record of listPending(dir)) {
    if (
      record.phase === "reported" &&
      (record.followUp === undefined || record.followUp === null)
    ) {
      removePendingFile(dir, record.wake.roomId, record.wake.agentId);
      continue;
    }
    const key = laneKey(record.wake);
    if (deps.lane.admit(key, record.wake) === "start") {
      jobs.push(record);
    }
  }
  const withDir = { ...deps, pendingDir: dir };
  const runJob = async (index) => {
    const record = jobs[index];
    if (record === undefined) {
      return;
    }
    const key = laneKey(record.wake);
    try {
      await drivePending(record.wake, withDir);
    } finally {
      deps.lane.release(key);
    }
    await runJob(index + 1);
  };
  await runJob(0);
};

export const handleWake = (http, deps) => {
  const now = deps.now ?? Date.now();
  const done = Promise.resolve();
  if (http.method !== "POST") {
    return { body: {}, done, status: 404 };
  }
  if (
    !(
      verifySignature(
        deps.config.webhookSecret,
        http.timestamp,
        http.body,
        http.signature
      ) &&
      rememberSignature(
        deps.seenSignatures,
        signatureDigest(http.signature),
        now
      )
    )
  ) {
    return {
      body: {
        message: "Signature did not match. Check the webhook secret and clock.",
        ok: false,
      },
      done,
      status: 401,
    };
  }
  let wake;
  try {
    wake = JSON.parse(http.body);
  } catch {
    return {
      body: { message: "Wake body must be JSON.", ok: false },
      done,
      status: 400,
    };
  }
  const decision =
    typeof deps.accept === "function"
      ? deps.accept(wake)
      : acceptDelivery(deps.seenDeliveries, wake.deliveryId, now);
  if (decision === "missing") {
    return {
      body: { message: "Wake body needs a deliveryId.", ok: false },
      done,
      status: 400,
    };
  }
  if (decision === "duplicate") {
    return { body: { duplicate: true, ok: true }, done, status: 200 };
  }
  const stored = deps.pendingDir
    ? acceptPending(deps.pendingDir, wake)
    : undefined;
  if (stored === "same") {
    return { body: { duplicate: true, ok: true }, done, status: 200 };
  }
  const key = laneKey(wake);
  const admitted = deps.lane.admit(key, wake);
  const markRead = deps.markRead ?? markDelivered;
  const run = async (current) => {
    if (deps.pendingDir) {
      try {
        await drivePending(current, deps);
      } finally {
        deps.lane.release(key);
      }
      return;
    }
    try {
      const result = await deps.start(
        current,
        deps.config,
        promptFor(current, deps.config.agentName)
      );
      if (result?.status === 200) {
        await markRead(deps.config, current);
      }
    } finally {
      const next = deps.lane.finish(key);
      if (next !== undefined) {
        await run(next);
      }
    }
  };
  if (admitted === "coalesced") {
    return { body: { coalesced: true, ok: true }, done, status: 200 };
  }
  const existing = deps.pendingDir
    ? readPendingFile(deps.pendingDir, wake.roomId, wake.agentId)
    : undefined;
  const toRun = stored === "queued" && existing?.wake ? existing.wake : wake;
  return {
    body: { coalesced: stored === "queued", ok: true },
    done: run(toRun),
    status: 200,
  };
};

export const serve = (start) => {
  const config = loadConfig();
  if (
    typeof config.webhookSecret !== "string" ||
    config.webhookSecret.length === 0
  ) {
    console.error(
      "Set webhookSecret in agent-rooms.listener.json or AGENT_ROOMS_WEBHOOK_SECRET."
    );
    process.exit(1);
  }
  const seenSignatures = new Map();
  const lane = createLane();
  const deliveryDir = path.join(stateDir(), "deliveries");
  const pendingDir = path.join(stateDir(), "pending");
  const listenerDeps = {
    accept: (wake) =>
      recordDelivery(
        deliveryDir,
        String(wake.roomId ?? ""),
        String(wake.agentId ?? ""),
        wake.deliveryId,
        Date.now()
      ),
    config,
    lane,
    pendingDir,
    seenDeliveries: new Map(),
    seenSignatures,
    start,
  };
  const resumed = resumeUnfinished(pendingDir, listenerDeps);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const timestamp = req.headers["x-agent-rooms-timestamp"];
    const signature = req.headers["x-agent-rooms-signature"];
    const header = (value) => (Array.isArray(value) ? value[0] : value);
    const result = await handleWake(
      {
        body,
        method: req.method,
        signature: header(signature),
        timestamp: header(timestamp),
      },
      listenerDeps
    );
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
    result.done.catch((error) => {
      console.error(error);
    });
  });
  resumed.catch((error) => {
    console.error(error);
  });
  server.listen(config.port, config.host, () => {
    console.log(`agent-rooms listener on http://${config.host}:${config.port}`);
  });
};

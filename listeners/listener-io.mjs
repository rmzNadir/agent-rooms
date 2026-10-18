import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const maxSkewMs = 5 * 60 * 1000;

export const verifySignature = (secret, timestamp, body, header) => {
  if (
    typeof secret !== "string" ||
    typeof timestamp !== "string" ||
    typeof body !== "string" ||
    typeof header !== "string"
  ) {
    return false;
  }
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > maxSkewMs) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const presented = header.startsWith("sha256=")
    ? header.slice("sha256=".length)
    : header;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

export const signatureDigest = (header) => {
  if (typeof header !== "string") {
    return "";
  }
  const hex = header.startsWith("sha256=")
    ? header.slice("sha256=".length)
    : header;
  return hex.toLowerCase();
};

export const rememberSignature = (seen, signature, now) => {
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) {
      seen.delete(key);
    }
  }
  if (seen.has(signature)) {
    return false;
  }
  seen.set(signature, now + maxSkewMs);
  return true;
};

export const stateDir = () => {
  const dir = path.join(homedir(), ".agent-rooms");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const sessionName = (roomId, agentId) => `${roomId}__${agentId}.json`;

export const replaceFile = (tmp, dest, fsImpl = { renameSync, rmSync }) => {
  try {
    fsImpl.renameSync(tmp, dest);
  } catch {
    fsImpl.rmSync(dest, { force: true });
    fsImpl.renameSync(tmp, dest);
  }
};

const writeJsonAtomic = (dest, value) => {
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  replaceFile(tmp, dest);
};

export const writeSessionFile = (dir, roomId, agentId, sessionId) => {
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, sessionName(roomId, agentId)), {
    sessionId,
    updatedAt: Date.now(),
  });
};

export const readSessionFile = (dir, roomId, agentId) => {
  const file = path.join(dir, sessionName(roomId, agentId));
  if (!existsSync(file)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed !== null &&
    typeof parsed === "object" &&
    typeof parsed.sessionId === "string"
    ? parsed.sessionId
    : undefined;
};

const sessionsDir = () => {
  const dir = path.join(stateDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
};

export const rememberSession = (wake, result) => {
  const sessionId = findSessionId(result.body.stdout ?? "");
  if (sessionId !== undefined) {
    writeSession(wake.roomId, wake.agentId, sessionId);
  }
  return result;
};

const writeSession = (roomId, agentId, sessionId) => {
  writeSessionFile(sessionsDir(), roomId, agentId, sessionId);
};

export const sessionFor = (roomId, agentId) =>
  readSessionFile(sessionsDir(), roomId, agentId);

export const loadConfig = () => {
  const file =
    process.env.AGENT_ROOMS_LISTENER_CONFIG ??
    path.join(process.cwd(), "agent-rooms.listener.json");
  const fromFile = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const listen =
    process.env.AGENT_ROOMS_LISTEN ?? fromFile.listen ?? "127.0.0.1:8788";
  const [host, portText] = listen.split(":");
  return {
    agentName:
      process.env.AGENT_ROOMS_AGENT_NAME ?? fromFile.agentName ?? "agent",
    bearerToken: process.env.AGENT_ROOMS_TOKEN ?? fromFile.bearerToken,
    claudeBin:
      process.env.CLAUDE_BIN ??
      fromFile.claudeBin ??
      (process.platform === "win32" ? "claude.cmd" : "claude"),
    claudeExtraArgs: fromFile.claudeExtraArgs ?? [],
    codexBin:
      process.env.CODEX_BIN ??
      fromFile.codexBin ??
      (process.platform === "win32" ? "codex.cmd" : "codex"),
    codexExtraArgs: fromFile.codexExtraArgs ?? [],
    host: host && host.length > 0 ? host : "127.0.0.1",
    mcpUrl: process.env.AGENT_ROOMS_MCP_URL ?? fromFile.mcpUrl,
    port: Number(portText ?? 8788),
    webhookSecret:
      process.env.AGENT_ROOMS_WEBHOOK_SECRET ?? fromFile.webhookSecret,
    workdir: fromFile.workdir ?? process.cwd(),
  };
};

export const writeMcpConfig = (config) => {
  const file = path.join(stateDir(), "mcp.json");
  const document = {
    mcpServers: {
      "agent-rooms": {
        headers: { Authorization: `Bearer ${config.bearerToken}` },
        type: "http",
        url: config.mcpUrl,
      },
    },
  };
  writeFileSync(file, JSON.stringify(document, null, 2));
  return file;
};

export const spawnHarness = ({ bin, args, cwd, env }) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => {
      resolve({
        body: {
          message: `Could not start ${bin}. The listener will retry this wake.`,
          ok: false,
        },
        status: 500,
      });
    });
    child.on("close", (code) => {
      resolve({
        body: { code, ok: code === 0, stderr, stdout },
        status: code === 0 ? 200 : 500,
      });
    });
  });

const sessionIdOf = (parsed) => {
  if (parsed === null || typeof parsed !== "object") {
    return;
  }
  if (typeof parsed.session_id === "string") {
    return parsed.session_id;
  }
  if (typeof parsed.sessionId === "string") {
    return parsed.sessionId;
  }
  if (
    parsed.type === "thread.started" &&
    typeof parsed.thread_id === "string"
  ) {
    return parsed.thread_id;
  }
};

// Claude prints one JSON object. `codex exec --json` prints JSON lines, and the session is the thread id.
export const findSessionId = (stdout) => {
  for (const line of [stdout, ...stdout.split("\n")]) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let found;
    try {
      found = sessionIdOf(JSON.parse(trimmed));
    } catch {
      found = undefined;
    }
    if (found !== undefined) {
      return found;
    }
  }
};

export const codexArgs = (extraArgs, previous, prompt) =>
  previous === undefined
    ? [...extraArgs, "exec", "--json", prompt]
    : [...extraArgs, "exec", "resume", "--json", previous, prompt];

const deliveryTtlMs = 30 * 60 * 1000;

export const acceptDelivery = (seen, deliveryId, now, ttl = deliveryTtlMs) => {
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    return "missing";
  }
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) {
      seen.delete(key);
    }
  }
  const expiresAt = seen.get(deliveryId);
  if (expiresAt !== undefined && expiresAt > now) {
    return "duplicate";
  }
  seen.set(deliveryId, now + ttl);
  return "fresh";
};

const readDeliveryMap = (file) => {
  const seen = new Map();
  if (!existsSync(file)) {
    return seen;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return seen;
    }
    for (const [id, expiresAt] of Object.entries(parsed)) {
      if (typeof expiresAt === "number") {
        seen.set(id, expiresAt);
      }
    }
  } catch {
    return seen;
  }
  return seen;
};

export const recordDelivery = (dir, roomId, agentId, deliveryId, now) => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${roomId}__${agentId}.json`);
  const seen = readDeliveryMap(file);
  const decision = acceptDelivery(seen, deliveryId, now);
  writeJsonAtomic(file, Object.fromEntries(seen));
  return decision;
};

export const createLane = () => {
  const lanes = new Map();
  return {
    admit(key, wake) {
      const lane = lanes.get(key);
      if (lane !== undefined) {
        lane.followUp = wake;
        return "coalesced";
      }
      lanes.set(key, { followUp: undefined });
      return "start";
    },
    finish(key) {
      const lane = lanes.get(key);
      if (lane === undefined) {
        return;
      }
      const next = lane.followUp;
      if (next === undefined) {
        lanes.delete(key);
        return;
      }
      lane.followUp = undefined;
      return next;
    },
    release(key) {
      lanes.delete(key);
    },
  };
};

export const maxHarnessAttempts = 3;

export const harnessRetryDelayMs = (attemptsSoFar) =>
  Math.min(30_000, 1000 * 2 ** Math.max(0, attemptsSoFar - 1));

const pendingPath = (dir, roomId, agentId) =>
  path.join(dir, `${roomId}__${agentId}.json`);

export const readPendingFile = (dir, roomId, agentId) => {
  const file = pendingPath(dir, roomId, agentId);
  if (!existsSync(file)) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    parsed.wake === undefined
  ) {
    return;
  }
  if (typeof parsed.attempts !== "number" || typeof parsed.phase !== "string") {
    return;
  }
  return parsed;
};

export const writePendingFile = (dir, roomId, agentId, record) => {
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(pendingPath(dir, roomId, agentId), record);
};

export const removePendingFile = (dir, roomId, agentId) => {
  const file = pendingPath(dir, roomId, agentId);
  if (existsSync(file)) {
    rmSync(file);
  }
};

export const acceptPending = (dir, wake) => {
  const existing = readPendingFile(dir, wake.roomId, wake.agentId);
  if (existing?.wake?.deliveryId === wake.deliveryId) {
    return "same";
  }
  if (existing?.followUp?.deliveryId === wake.deliveryId) {
    return "same";
  }
  if (existing === undefined) {
    writePendingFile(dir, wake.roomId, wake.agentId, {
      attempts: 0,
      followUp: null,
      phase: "queued",
      wake,
    });
    return "start";
  }
  writePendingFile(dir, wake.roomId, wake.agentId, {
    ...existing,
    followUp: wake,
  });
  return "queued";
};

const failureBody = (wake) =>
  `@human I failed to process messages ${wake.fromSeq} through ${wake.toSeq} after ${maxHarnessAttempts} attempts.`;

export const postFailure = async (
  config,
  wake,
  fetchImpl = globalThis.fetch
) => {
  if (
    typeof config.mcpUrl !== "string" ||
    typeof config.bearerToken !== "string"
  ) {
    return false;
  }
  const body = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: {
        body: failureBody(wake),
        mentions: ["human"],
        room: wake.roomId,
      },
      name: "post_message",
    },
  });
  try {
    const response = await fetchImpl(config.mcpUrl, {
      body,
      headers: {
        authorization: `Bearer ${config.bearerToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const text = await response.text();
    return response.ok && !text.includes('"isError":true');
  } catch {
    return false;
  }
};

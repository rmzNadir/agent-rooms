import { readFileSync, writeFileSync } from "node:fs";
import { readEnv } from "../src/boundary/external.ts";
import {
  ensureBucket,
  pinnedVersion,
  putObject,
  retainPrefix,
  rollBack,
} from "./cf-client.ts";
import {
  type Env,
  envFrom,
  envValue,
  need,
  tokenEnvName,
  type VerifyAgent,
  verifyAgentsFromEnv,
} from "./deploy-profile.ts";
import type { AppCall, CfCall } from "./http-text.ts";
import { appFetch, cfFetch } from "./http-text.ts";
import { parseBackup } from "./room-parse.ts";
import { authProblems, readBackup } from "./room-read.ts";
import {
  backupKey,
  backupPrefix,
  compareBackups,
  scriptNameFromUrl,
} from "./snapshot-diff.ts";

export interface GuardIo {
  readonly call: CfCall;
  readonly err: (line: string) => void;
  readonly http: AppCall;
  readonly log: (line: string) => void;
  readonly nowIso: () => string;
  readonly nowMs: () => number;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, body: string) => void;
}

export interface GuardConfig {
  readonly account: string | undefined;
  readonly admin: string | undefined;
  readonly bucket: string | undefined;
  readonly file: string | undefined;
  readonly prefix: string | undefined;
  readonly sha: string | undefined;
  readonly url: string | undefined;
  readonly verifyAgents: readonly VerifyAgent[];
  readonly versionFile: string | undefined;
  readonly worker: string | undefined;
}

export const workerScript = (url: string, override: string | undefined) => {
  const fromUrl = url.length === 0 ? undefined : scriptNameFromUrl(url);
  if (fromUrl !== undefined) {
    return fromUrl;
  }
  return override;
};

export const configFromEnv = (env: Env): GuardConfig => ({
  account: envValue(env, "CLOUDFLARE_ACCOUNT_ID"),
  admin: envValue(env, "AGENT_ROOMS_ADMIN_TOKEN"),
  bucket: envValue(env, "AGENT_ROOMS_BACKUP_BUCKET"),
  file: envValue(env, "AGENT_ROOMS_BACKUP_FILE"),
  prefix: envValue(env, "AGENT_ROOMS_BACKUP_PREFIX"),
  sha: envValue(env, "GITHUB_SHA"),
  url: envValue(env, "AGENT_ROOMS_URL"),
  verifyAgents: verifyAgentsFromEnv(env),
  versionFile: envValue(env, "AGENT_ROOMS_VERSION_FILE"),
  worker: workerScript(
    envValue(env, "AGENT_ROOMS_URL") ?? "",
    envValue(env, "AGENT_ROOMS_WORKER_NAME")
  ),
});

const requireWorker = (config: GuardConfig) => {
  if (config.worker === undefined) {
    throw new Error(
      "missing AGENT_ROOMS_WORKER_NAME for a non workers.dev AGENT_ROOMS_URL"
    );
  }
  return config.worker;
};

export const runBackup = async (config: GuardConfig, io: GuardIo) => {
  const account = need(config.account, "CLOUDFLARE_ACCOUNT_ID");
  const admin = need(config.admin, "AGENT_ROOMS_ADMIN_TOKEN");
  const url = need(config.url, "AGENT_ROOMS_URL");
  const file = need(config.file, "AGENT_ROOMS_BACKUP_FILE");
  const prefix = backupPrefix(config.prefix);
  const sha = need(config.sha, "GITHUB_SHA");
  if (prefix === undefined) {
    throw new Error("AGENT_ROOMS_BACKUP_PREFIX must be deploy or nightly");
  }
  if (url.length === 0) {
    throw new Error("missing AGENT_ROOMS_URL");
  }
  const bucket = need(config.bucket, "AGENT_ROOMS_BACKUP_BUCKET");
  await ensureBucket(io.call, account, bucket);
  const takenAt = io.nowIso();
  const backup = await readBackup(io.http, admin, takenAt);
  const body = JSON.stringify(backup);
  const key = backupKey(prefix, takenAt, sha);
  await putObject(io.call, account, bucket, key, body);
  io.writeFile(file, body);
  const removed = await retainPrefix(
    io.call,
    account,
    bucket,
    `${prefix}/`,
    io.nowMs()
  );
  io.log(`stored ${key} bytes=${body.length} expired=${removed}`);
};

export const runPin = async (config: GuardConfig, io: GuardIo) => {
  const account = need(config.account, "CLOUDFLARE_ACCOUNT_ID");
  const worker = requireWorker(config);
  const file = need(config.versionFile, "AGENT_ROOMS_VERSION_FILE");
  const version = await pinnedVersion(io.call, account, worker);
  io.writeFile(file, version ?? "");
  io.log(version === undefined ? "pinned none" : `pinned ${version}`);
};

const agentProblems = (agents: readonly VerifyAgent[], http: AppCall) =>
  Promise.all(
    agents.map(async (agent) => {
      const token = need(agent.token, tokenEnvName(agent.label));
      return await authProblems(http, token, agent.label);
    })
  ).then((groups) => groups.flat());

export const runVerify = async (config: GuardConfig, io: GuardIo) => {
  const admin = need(config.admin, "AGENT_ROOMS_ADMIN_TOKEN");
  need(config.url, "AGENT_ROOMS_URL");
  const file = need(config.file, "AGENT_ROOMS_BACKUP_FILE");
  const before = parseBackup(io.readFile(file));
  const after = await readBackup(io.http, admin, io.nowIso());
  const lines = [
    ...compareBackups(before, after),
    ...(await authProblems(io.http, admin, "admin")),
    ...(await agentProblems(config.verifyAgents, io.http)),
  ];
  if (lines.length > 0) {
    for (const line of lines) {
      io.err(line);
    }
    throw new Error("verification failed");
  }
  io.log(`verified rooms=${after.rooms.length} agents=${after.agents.length}`);
};

export const runRollback = async (config: GuardConfig, io: GuardIo) => {
  const account = need(config.account, "CLOUDFLARE_ACCOUNT_ID");
  const worker = requireWorker(config);
  const file = need(config.versionFile, "AGENT_ROOMS_VERSION_FILE");
  const version = io.readFile(file).trim();
  if (version.length === 0) {
    throw new Error("no previous worker version to roll back");
  }
  await rollBack(io.call, account, worker, version);
  io.log(`rolled back to ${version}`);
};

export const execute = async (
  command: string | undefined,
  config: GuardConfig,
  io: GuardIo
) => {
  if (command === "backup") {
    await runBackup(config, io);
    return;
  }
  if (command === "pin") {
    await runPin(config, io);
    return;
  }
  if (command === "verify") {
    await runVerify(config, io);
    return;
  }
  if (command === "rollback") {
    await runRollback(config, io);
    return;
  }
  throw new Error("usage: backup | pin | verify | rollback");
};

const envRecord = (): Env => envFrom(readEnv);

const ioFromEnv = (env: Env): GuardIo => ({
  call: cfFetch(
    need(envValue(env, "CLOUDFLARE_API_TOKEN"), "CLOUDFLARE_API_TOKEN")
  ),
  err: (line) => {
    console.error(line);
  },
  http: appFetch(envValue(env, "AGENT_ROOMS_URL") ?? ""),
  log: (line) => {
    console.log(line);
  },
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, body) => {
    writeFileSync(path, body, { mode: 0o600 });
  },
});

if (import.meta.main) {
  try {
    const env = envRecord();
    await execute(process.argv[2], configFromEnv(env), ioFromEnv(env));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "deploy guard failed"
    );
    process.exit(1);
  }
}

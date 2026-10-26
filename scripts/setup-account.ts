import { spawn } from "node:child_process";
import { readEnv } from "../src/boundary/external.ts";
import { ensureBucket } from "./cf-client.ts";
import {
  type Env,
  envFrom,
  envValue,
  profileProblems,
  tokenEnvName,
} from "./deploy-profile.ts";
import { cfFetch } from "./http-text.ts";
import { findZoneName, zoneFailure } from "./zone-lookup.ts";

export interface SetupCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly input: string | undefined;
}

export interface SetupRequest {
  readonly accountId: string;
  readonly adminToken: string | undefined;
  readonly agentTokens: Readonly<Record<string, string | undefined>>;
  readonly apiToken: string;
  readonly bucket: string;
  readonly domain: string | undefined;
  readonly environment: string;
  readonly existingSecrets: readonly string[];
  readonly repo: string;
  readonly stage: string;
  readonly url: string | undefined;
  readonly verifyAgents: string | undefined;
  readonly verifyTokens: string | undefined;
  readonly workerName: string | undefined;
}

export interface SetupIo {
  readonly bootstrap: () => Promise<void>;
  readonly bucket: (account: string, name: string) => Promise<void>;
  readonly exec: (command: SetupCommand) => Promise<string>;
  readonly log: (line: string) => void;
  readonly mintAdmin: () => string;
  readonly zone: (account: string, hostname: string) => Promise<void>;
}

const labelsOf = (listed: string) =>
  listed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const secretNames = (text: string) =>
  text
    .split("\n")
    .map((line) => line.split("\t")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);

export const redact = (text: string, secrets: readonly string[]) =>
  secrets.reduce(
    (current, hidden) =>
      hidden.length < 8 ? current : current.split(hidden).join("[redacted]"),
    text
  );

export const mintAdminToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const packedVerifyTokens = (request: SetupRequest) => {
  if (request.verifyTokens !== undefined) {
    return request.verifyTokens;
  }
  if (request.verifyAgents === undefined) {
    return;
  }
  const parts = labelsOf(request.verifyAgents).map((label) => {
    const token = request.agentTokens[label];
    return token === undefined || token.length === 0
      ? undefined
      : `${label}=${token}`;
  });
  if (parts.some((part) => part === undefined)) {
    return;
  }
  return parts.join(",");
};

const variable = (repo: string, name: string, value: string): SetupCommand => ({
  args: ["variable", "set", name, "--repo", repo, "--body", value],
  command: "gh",
  input: undefined,
});

const secret = (
  repo: string,
  environment: string,
  name: string,
  value: string
): SetupCommand => ({
  args: ["secret", "set", name, "--repo", repo, "--env", environment],
  command: "gh",
  input: value,
});

const hasSecret = (request: SetupRequest, name: string) =>
  request.existingSecrets.includes(name);

const profileEnv = (request: SetupRequest): Env => ({
  AGENT_ROOMS_BACKUP_BUCKET: request.bucket,
  AGENT_ROOMS_DOMAIN: request.domain,
  AGENT_ROOMS_GITHUB_ENVIRONMENT: request.environment,
  AGENT_ROOMS_STAGE: request.stage,
  AGENT_ROOMS_VERIFY_AGENTS: request.verifyAgents,
  AGENT_ROOMS_VERIFY_TOKENS: request.verifyTokens,
});

export const githubCommands = (
  request: SetupRequest,
  mintedAdmin: string | undefined
): readonly SetupCommand[] => {
  const { environment, repo } = request;
  const commands: SetupCommand[] = [
    {
      args: [
        "api",
        "--method",
        "PUT",
        `repos/${repo}/environments/${environment}`,
      ],
      command: "gh",
      input: undefined,
    },
    variable(repo, "AGENT_ROOMS_STAGE", request.stage),
    variable(repo, "AGENT_ROOMS_GITHUB_ENVIRONMENT", environment),
    variable(repo, "AGENT_ROOMS_BACKUP_BUCKET", request.bucket),
  ];
  if (request.domain !== undefined) {
    commands.push(variable(repo, "AGENT_ROOMS_DOMAIN", request.domain));
  }
  if (request.verifyAgents !== undefined) {
    commands.push(
      variable(repo, "AGENT_ROOMS_VERIFY_AGENTS", request.verifyAgents)
    );
  }
  const secrets: ReadonlyArray<readonly [string, string | undefined]> = [
    ["AGENT_ROOMS_ADMIN_TOKEN", request.adminToken ?? mintedAdmin],
    ["AGENT_ROOMS_URL", request.url],
    ["AGENT_ROOMS_VERIFY_TOKENS", packedVerifyTokens(request)],
    ["AGENT_ROOMS_WORKER_NAME", request.workerName],
    ["CLOUDFLARE_ACCOUNT_ID", request.accountId],
    ["CLOUDFLARE_API_TOKEN", request.apiToken],
  ];
  for (const [name, value] of secrets) {
    if (value !== undefined && value.length > 0 && !hasSecret(request, name)) {
      commands.push(secret(repo, environment, name, value));
    }
  }
  return commands;
};

const forwardedTokenSecrets = new Set([
  "AGENT_ROOMS_BROBERT_TOKEN",
  "AGENT_ROOMS_CODEX_TOKEN",
]);

const tokenPresent = (token: string | undefined) =>
  token !== undefined && token.length > 0;

const coveredByWorkflow = (request: SetupRequest, label: string) => {
  const name = tokenEnvName(label);
  return forwardedTokenSecrets.has(name) && hasSecret(request, name);
};

const verifyListSettled = (request: SetupRequest) =>
  request.verifyAgents === undefined ||
  request.verifyTokens !== undefined ||
  packedVerifyTokens(request) !== undefined ||
  hasSecret(request, "AGENT_ROOMS_VERIFY_TOKENS");

export const stillMissing = (request: SetupRequest): readonly string[] => {
  const missing: string[] = [];
  if (request.url === undefined && !hasSecret(request, "AGENT_ROOMS_URL")) {
    missing.push("AGENT_ROOMS_URL");
  }
  if (verifyListSettled(request) || request.verifyAgents === undefined) {
    return missing;
  }
  const uncovered = labelsOf(request.verifyAgents).some(
    (label) => !coveredByWorkflow(request, label)
  );
  if (uncovered) {
    missing.push("AGENT_ROOMS_VERIFY_TOKENS");
  }
  return missing;
};

export const verifyTokenGap = (request: SetupRequest): string | undefined => {
  if (verifyListSettled(request) || request.verifyAgents === undefined) {
    return undefined;
  }
  const labels = labelsOf(request.verifyAgents);
  const storedLocally = labels.some((label) =>
    tokenPresent(request.agentTokens[label])
  );
  const uncovered = labels.some((label) => !coveredByWorkflow(request, label));
  if (storedLocally && uncovered) {
    return "AGENT_ROOMS_VERIFY_TOKENS was not stored";
  }
  return undefined;
};

const secretValues = (request: SetupRequest, mintedAdmin: string | undefined) =>
  [
    mintedAdmin,
    request.accountId,
    request.adminToken,
    request.apiToken,
    request.verifyTokens,
    packedVerifyTokens(request),
    ...Object.values(request.agentTokens),
  ].filter((value): value is string => value !== undefined && value.length > 0);

const adminToMint = (request: SetupRequest) =>
  request.adminToken === undefined &&
  !hasSecret(request, "AGENT_ROOMS_ADMIN_TOKEN");

const commandText = async (
  io: SetupIo,
  command: SetupCommand,
  secrets: readonly string[]
) => {
  try {
    return redact(await io.exec(command), secrets).trim();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "setup command failed";
    throw new Error(redact(message, secrets), { cause: error });
  }
};

export const existingSecretsOrEmpty = async (load: () => Promise<string>) => {
  try {
    return secretNames(await load());
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("HTTP 404")) {
      return [];
    }
    throw error;
  }
};

export const runSetup = async (request: SetupRequest, io: SetupIo) => {
  const gap = verifyTokenGap(request);
  const problems = [
    ...profileProblems(profileEnv(request)),
    ...(request.accountId.length === 0
      ? ["missing CLOUDFLARE_ACCOUNT_ID"]
      : []),
    ...(request.apiToken.length === 0 ? ["missing CLOUDFLARE_API_TOKEN"] : []),
    ...(gap === undefined ? [] : [gap]),
  ];
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  if (request.domain !== undefined) {
    await io.zone(request.accountId, request.domain);
  }
  await io.bootstrap();
  await io.bucket(request.accountId, request.bucket);
  const minted = adminToMint(request) ? io.mintAdmin() : undefined;
  const secrets = secretValues(request, minted);
  await githubCommands(request, minted).reduce(async (chain, command) => {
    await chain;
    const text = await commandText(io, command, secrets);
    if (text.length > 0) {
      io.log(text);
    }
  }, Promise.resolve());
  for (const name of stillMissing(request)) {
    io.log(`still needed: ${name}`);
  }
};

export const spawnCommand = (command: SetupCommand) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err.length > 0 ? err : out));
    });
    child.stdin.end(command.input ?? "");
  });

export const requestFromEnv = (
  env: Env,
  repo: string,
  existingSecrets: readonly string[]
): SetupRequest => {
  const listed = envValue(env, "AGENT_ROOMS_VERIFY_AGENTS");
  const agentTokens: { [key: string]: string | undefined } = {};
  if (listed !== undefined) {
    for (const label of labelsOf(listed)) {
      agentTokens[label] = envValue(env, tokenEnvName(label));
    }
  }
  return {
    accountId: envValue(env, "CLOUDFLARE_ACCOUNT_ID") ?? "",
    adminToken: envValue(env, "AGENT_ROOMS_ADMIN_TOKEN"),
    agentTokens,
    apiToken: envValue(env, "CLOUDFLARE_API_TOKEN") ?? "",
    bucket: envValue(env, "AGENT_ROOMS_BACKUP_BUCKET") ?? "",
    domain: envValue(env, "AGENT_ROOMS_DOMAIN"),
    environment: envValue(env, "AGENT_ROOMS_GITHUB_ENVIRONMENT") ?? "",
    existingSecrets,
    repo,
    stage: envValue(env, "AGENT_ROOMS_STAGE") ?? "",
    url: envValue(env, "AGENT_ROOMS_URL"),
    verifyAgents: listed,
    verifyTokens: envValue(env, "AGENT_ROOMS_VERIFY_TOKENS"),
    workerName: envValue(env, "AGENT_ROOMS_WORKER_NAME"),
  };
};

const liveIo = (token: string): SetupIo => ({
  bootstrap: async () => {
    await spawnCommand({
      args: ["alchemy", "provider", "cloudflare", "bootstrap"],
      command: "bunx",
      input: undefined,
    });
  },
  bucket: (account, name) => ensureBucket(cfFetch(token), account, name),
  exec: spawnCommand,
  log: (line) => {
    console.log(line);
  },
  mintAdmin: mintAdminToken,
  zone: async (account, hostname) => {
    const found = await findZoneName(cfFetch(token), account, hostname);
    if (found === undefined) {
      throw new Error(zoneFailure(hostname));
    }
  },
});

if (import.meta.main) {
  try {
    const env = envFrom(readEnv);
    const problems = profileProblems(env);
    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }
    const repo = (
      readEnv("GITHUB_REPOSITORY") ??
      (await spawnCommand({
        args: [
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "--jq",
          ".nameWithOwner",
        ],
        command: "gh",
        input: undefined,
      }))
    ).trim();
    const environment = envValue(env, "AGENT_ROOMS_GITHUB_ENVIRONMENT") ?? "";
    const existing = await existingSecretsOrEmpty(() =>
      spawnCommand({
        args: ["secret", "list", "--env", environment, "--repo", repo],
        command: "gh",
        input: undefined,
      })
    );
    await runSetup(
      requestFromEnv(env, repo, existing),
      liveIo(envValue(env, "CLOUDFLARE_API_TOKEN") ?? "")
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "setup failed";
    console.error(
      redact(message, [
        readEnv("CLOUDFLARE_API_TOKEN") ?? "",
        readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "",
        readEnv("AGENT_ROOMS_VERIFY_TOKENS") ?? "",
      ])
    );
    process.exit(1);
  }
}

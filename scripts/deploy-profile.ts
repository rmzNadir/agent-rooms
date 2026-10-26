import { readEnv } from "../src/boundary/external.ts";
import { domainProblem } from "../src/runtime/worker-surface.ts";

export interface Env {
  readonly [key: string]: string | undefined;
}

export interface VerifyAgent {
  readonly label: string;
  readonly token: string | undefined;
}

const stagePattern = /^[a-z][a-z0-9-]{0,40}$/u;
const bucketPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u;
const environmentPattern = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/u;
const labelPattern = /^[a-z][a-z0-9-]{0,30}$/u;
const packedSeparator = /[\n,]/u;

const profileChecks = [
  ["AGENT_ROOMS_BACKUP_BUCKET", bucketPattern],
  ["AGENT_ROOMS_GITHUB_ENVIRONMENT", environmentPattern],
  ["AGENT_ROOMS_STAGE", stagePattern],
] as const;

const fixedKeys = [
  "AGENT_ROOMS_ADMIN_TOKEN",
  "AGENT_ROOMS_BACKUP_BUCKET",
  "AGENT_ROOMS_BACKUP_FILE",
  "AGENT_ROOMS_BACKUP_PREFIX",
  "AGENT_ROOMS_DOMAIN",
  "AGENT_ROOMS_GITHUB_ENVIRONMENT",
  "AGENT_ROOMS_STAGE",
  "AGENT_ROOMS_URL",
  "AGENT_ROOMS_VERIFY_AGENTS",
  "AGENT_ROOMS_VERIFY_TOKENS",
  "AGENT_ROOMS_VERSION_FILE",
  "AGENT_ROOMS_WORKER_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "GITHUB_SHA",
] as const;

export const envValue = (env: Env, key: string) => {
  const value = env[key];
  return value === undefined || value.length === 0 ? undefined : value;
};

export const need = (value: string | undefined, name: string) => {
  if (value === undefined) {
    throw new Error(`missing ${name}`);
  }
  return value;
};

export const tokenEnvName = (label: string) =>
  `AGENT_ROOMS_${label.toUpperCase().replaceAll("-", "_")}_TOKEN`;

const assertLabel = (label: string) => {
  if (!labelPattern.test(label)) {
    throw new Error("bad verify agent entry");
  }
  return label;
};

const partsOf = (text: string, separator: RegExp | string) =>
  text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const packedAgents = (packed: string): readonly VerifyAgent[] =>
  partsOf(packed, packedSeparator).map((part) => {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw new Error("bad verify agent entry");
    }
    const labelText = assertLabel(part.slice(0, eq).trim());
    const token = part.slice(eq + 1).trim();
    if (token.length === 0) {
      throw new Error(`missing token for ${labelText}`);
    }
    return { label: labelText, token };
  });

const listedAgents = (listed: string, env: Env): readonly VerifyAgent[] =>
  partsOf(listed, ",").map((label) => ({
    label: assertLabel(label),
    token: envValue(env, tokenEnvName(label)),
  }));

export const verifyAgentsFromEnv = (env: Env): readonly VerifyAgent[] => {
  const packed = envValue(env, "AGENT_ROOMS_VERIFY_TOKENS");
  if (packed !== undefined) {
    return packedAgents(packed);
  }
  const listed = envValue(env, "AGENT_ROOMS_VERIFY_AGENTS");
  if (listed === undefined) {
    return [];
  }
  return listedAgents(listed, env);
};

const checkProblem = (
  env: Env,
  name: string,
  pattern: RegExp
): string | undefined => {
  const value = envValue(env, name);
  if (value === undefined) {
    return `missing ${name}`;
  }
  if (!pattern.test(value)) {
    return `bad ${name}`;
  }
  return undefined;
};

const verifyProblem = (env: Env): string | undefined => {
  try {
    verifyAgentsFromEnv(env);
  } catch (error) {
    return error instanceof Error ? error.message : "bad verify agents";
  }
  return undefined;
};

const listedProblem = (problem: string | undefined) =>
  problem === undefined ? [] : [problem];

export const profileProblems = (env: Env): readonly string[] => {
  const problems = profileChecks.flatMap(([name, pattern]) => {
    const problem = checkProblem(env, name, pattern);
    return problem === undefined ? [] : [problem];
  });
  return [
    ...problems,
    ...listedProblem(verifyProblem(env)),
    ...listedProblem(domainProblem(envValue(env, "AGENT_ROOMS_DOMAIN"))),
  ];
};

export const envFrom = (read: (key: string) => string | undefined): Env => {
  const env: { [key: string]: string | undefined } = {};
  for (const key of fixedKeys) {
    env[key] = read(key);
  }
  const listed = envValue(env, "AGENT_ROOMS_VERIFY_AGENTS");
  if (
    listed !== undefined &&
    envValue(env, "AGENT_ROOMS_VERIFY_TOKENS") === undefined
  ) {
    for (const label of partsOf(listed, ",")) {
      if (labelPattern.test(label)) {
        const key = tokenEnvName(label);
        env[key] = read(key);
      }
    }
  }
  return env;
};

if (import.meta.main) {
  const problems = profileProblems(envFrom(readEnv));
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    process.exit(1);
  }
}

const hostnamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

const present = (value: string | undefined) =>
  value === undefined || value.length === 0 ? undefined : value;

const workersDevHost = (host: string) => host.endsWith(".workers.dev");

const workersDevName = (host: string) =>
  host === "workers.dev" || workersDevHost(host);

const bareHostname = (host: string) =>
  host.length <= 253 &&
  !host.includes("://") &&
  !host.includes("/") &&
  !host.includes(":") &&
  !host.includes(" ") &&
  hostnamePattern.test(host);

export interface DeployInput {
  readonly dev: boolean;
  readonly domain: string | undefined;
  readonly localState: boolean;
  readonly url: string | undefined;
  readonly workerName: string | undefined;
}

export interface DeploySurface {
  readonly domain?: string;
  readonly name?: string;
}

export const scriptNameFromUrl = (url: string | undefined) => {
  if (typeof url !== "string") {
    throw new TypeError("script url");
  }
  let host: string | undefined;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (!workersDevHost(host)) {
    return;
  }
  const name = host.slice(0, host.indexOf("."));
  if (name.length === 0) {
    return;
  }
  return name;
};

export const domainProblem = (
  value: string | undefined
): string | undefined => {
  if (value === undefined) {
    return;
  }
  if (workersDevName(value)) {
    return "AGENT_ROOMS_DOMAIN must not be a workers.dev host";
  }
  if (bareHostname(value)) {
    return;
  }
  return "AGENT_ROOMS_DOMAIN must be a bare hostname";
};

export const pinnedScriptName = (
  url: string | undefined,
  workerName: string | undefined
) => {
  if (url !== undefined) {
    const fromUrl = scriptNameFromUrl(url);
    if (fromUrl !== undefined) {
      return fromUrl;
    }
  }
  return present(workerName);
};

const devKey = "ALCHEMY_DEV";
const domainKey = "AGENT_ROOMS_DOMAIN";
const localKey = "AGENT_ROOMS_LOCAL_STATE";
const urlKey = "AGENT_ROOMS_URL";
const workerKey = "AGENT_ROOMS_WORKER_NAME";

export const deployInput = (
  read: (name: string) => string | undefined
): DeployInput => ({
  dev: read(devKey) === "true",
  domain: read(domainKey),
  localState: read(localKey) === "1",
  url: read(urlKey),
  workerName: read(workerKey),
});

export const publicBase = (
  domain: string | undefined,
  url: string | undefined
) => {
  const host = present(domain);
  if (host !== undefined && domainProblem(host) === undefined) {
    return `https://${host}`;
  }
  return present(url);
};

const surface = (
  name: string | undefined,
  domain: string | undefined
): DeploySurface => ({
  ...(domain === undefined ? {} : { domain }),
  ...(name === undefined ? {} : { name }),
});

// Durable Object class names are the logical names. They do not include
// the stage, so pinning this script name keeps their namespaces.
export const deploySurface = (input: DeployInput): DeploySurface => {
  if (input.dev || input.localState) {
    return {};
  }
  const domain = present(input.domain);
  const problem = domainProblem(domain);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  return surface(
    pinnedScriptName(present(input.url), present(input.workerName)),
    domain
  );
};

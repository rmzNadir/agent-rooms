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

export const scriptNameFromUrl = (url: string) => {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (!workersDevHost(host)) {
    return;
  }
  const [name] = host.split(".");
  if (name === undefined || name.length === 0) {
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
  const fromUrl = url === undefined ? undefined : scriptNameFromUrl(url);
  if (fromUrl !== undefined) {
    return fromUrl;
  }
  return present(workerName);
};

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

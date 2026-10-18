import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Json } from "effect/Schema";
import {
  at,
  isJsonObject,
  parseJson,
  readEnv,
} from "../src/boundary/external.ts";
import { agentInstructions } from "../src/mcp/guide.ts";
import {
  modernProtocolVersions,
  type SupportedProtocolVersion,
  supportedProtocolVersions,
} from "../src/mcp/protocol.ts";

export interface ConformanceTarget {
  readonly token: string;
  readonly url: string;
}

function fail(version: string, detail: string): never {
  throw new Error(`${version}: ${detail}`);
}

const sameList = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  actual.every((version, index) => version === expected[index]);

const negotiation = (modern: boolean, version: SupportedProtocolVersion) =>
  modern
    ? { versionNegotiation: { mode: { pin: version } } }
    : {
        supportedProtocolVersions: [version],
        versionNegotiation: { mode: "legacy" as const },
      };

const assertDiscover = (client: Client, version: SupportedProtocolVersion) => {
  const discovered = client.getDiscoverResult();
  if (discovered === undefined) {
    fail(version, "server/discover returned no result");
  }
  const { instructions, supportedVersions: supported } = discovered;
  if (!sameList(supported, modernProtocolVersions)) {
    fail(version, `supportedVersions ${supported.join(", ")}`);
  }
  if (instructions !== agentInstructions) {
    fail(version, "discover instructions differ from the guide");
  }
};

const toolText = (result: CallToolResult) =>
  result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const assertTools = async (
  client: Client,
  version: SupportedProtocolVersion
) => {
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === "whoami")) {
    fail(version, "tools/list omitted whoami");
  }
  const called = await client.callTool({ arguments: {}, name: "whoami" });
  const rendered = toolText(called);
  if (!rendered.includes('"displayName"')) {
    fail(version, `whoami returned ${rendered}`);
  }
};

const rethrowSession = (error: Error | string, version: string) => {
  if (error instanceof Error && error.message.startsWith(`${version}:`)) {
    throw error;
  }
  fail(version, error instanceof Error ? error.message : String(error));
};

const exercise = async (
  client: Client,
  modern: boolean,
  version: SupportedProtocolVersion
) => {
  if (modern) {
    assertDiscover(client, version);
  } else if (client.getInstructions() !== agentInstructions) {
    fail(version, "initialize instructions differ from the guide");
  }
  await assertTools(client, version);
};

const session = async (
  target: ConformanceTarget,
  version: SupportedProtocolVersion
) => {
  const modern = (modernProtocolVersions as readonly string[]).includes(
    version
  );
  const client = new Client(
    { name: "agent-rooms-conformance", version: "0" },
    negotiation(modern, version)
  );
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: { authorization: `Bearer ${target.token}` } },
  });
  try {
    await client.connect(transport);
    await exercise(client, modern, version);
  } catch (error) {
    rethrowSession(error instanceof Error ? error : String(error), version);
  } finally {
    await client.close();
  }
};

const postJson = async (
  url: string,
  headers: Record<string, string>,
  body: Json
) => {
  const init = {
    body: JSON.stringify(body),
    headers: { connection: "close", ...headers },
    method: "POST",
  };
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("ECONNRESET"))) {
      throw error;
    }
    return await fetch(url, init);
  }
};

const readJson = async (response: Response) => {
  const text = await response.text();
  try {
    return parseJson(text);
  } catch (error) {
    throw new Error(text, { cause: error });
  }
};

const expectUnauthorized = async (
  target: ConformanceTarget,
  version: string
) => {
  const response = await postJson(
    target.url,
    {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "conformance", version: "0" },
        protocolVersion: "2025-06-18",
      },
    }
  );
  if (response.status !== 401) {
    fail(version, `missing token returned ${response.status}`);
  }
};

const unsupportedBody = (version: SupportedProtocolVersion) =>
  (modernProtocolVersions as readonly string[]).includes(version)
    ? {
        id: 1,
        jsonrpc: "2.0",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "conformance",
              version: "0",
            },
            "io.modelcontextprotocol/protocolVersion": "1900-01-01",
          },
        },
      }
    : {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "conformance", version: "0" },
          protocolVersion: "1999-01-01",
        },
      };

const unsupportedHeaders = (target: ConformanceTarget, modern: boolean) => ({
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${target.token}`,
  "content-type": "application/json",
  "mcp-protocol-version": modern ? "1900-01-01" : "1999-01-01",
  ...(modern ? { "mcp-method": "server/discover" } : {}),
});

const errorObject = (version: string, parsed: Json) => {
  if (!isJsonObject(parsed)) {
    fail(version, "unsupported version was not a JSON-RPC error");
  }
  const rpcError = at(parsed, "error");
  if (rpcError === undefined || !isJsonObject(rpcError)) {
    fail(version, "unsupported version error had no data");
  }
  return rpcError;
};

const recordData = (version: string, data: Json | undefined) => {
  if (data === undefined || !isJsonObject(data)) {
    fail(version, "unsupported version omitted supported");
  }
  return data;
};

const supportedOf = (version: string, data: Json | undefined) => {
  const record = recordData(version, data);
  const supportedValue = at(record, "supported");
  if (!Array.isArray(supportedValue)) {
    fail(version, "unsupported version omitted supported");
  }
  const supported = supportedValue.map(String);
  if (!sameList(supported, supportedProtocolVersions)) {
    fail(version, `supported list ${supported.join(", ")}`);
  }
};

const expectUnsupported = async (
  target: ConformanceTarget,
  version: SupportedProtocolVersion
) => {
  const modern = (modernProtocolVersions as readonly string[]).includes(
    version
  );
  const response = await postJson(
    target.url,
    unsupportedHeaders(target, modern),
    unsupportedBody(version)
  );
  let parsed: Json;
  try {
    parsed = await readJson(response);
  } catch (error) {
    fail(version, error instanceof Error ? error.message : String(error));
  }
  if (response.status !== 400) {
    fail(version, `unsupported version returned ${response.status}`);
  }
  const rpcError = errorObject(version, parsed);
  if (at(rpcError, "code") !== -32_022) {
    fail(version, `unsupported version code ${String(at(rpcError, "code"))}`);
  }
  supportedOf(version, at(rpcError, "data"));
};

const checkVersion = async (
  target: ConformanceTarget,
  versions: readonly SupportedProtocolVersion[],
  index: number
): Promise<void> => {
  const version = versions[index];
  if (version === undefined) {
    return;
  }
  await session(target, version);
  await expectUnauthorized(target, version);
  await expectUnsupported(target, version);
  await checkVersion(target, versions, index + 1);
};

export const runConformance = (target: ConformanceTarget) =>
  checkVersion(target, supportedProtocolVersions, 0);

if (import.meta.main) {
  const url = readEnv("AGENT_ROOMS_URL");
  const token = readEnv("AGENT_ROOMS_TOKEN");
  if (
    url === undefined ||
    url.length === 0 ||
    token === undefined ||
    token.length === 0
  ) {
    console.error("Set AGENT_ROOMS_URL and AGENT_ROOMS_TOKEN.");
    process.exit(1);
  }
  const mcp = url.endsWith("/mcp") ? url : `${url.replace(/\/$/, "")}/mcp`;
  await runConformance({ token, url: mcp });
}

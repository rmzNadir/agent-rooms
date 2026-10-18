import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { agentInstructions } from "../src/mcp/guide.ts"
import { modernProtocolVersions, supportedProtocolVersions, type SupportedProtocolVersion } from "../src/mcp/protocol.ts"

export type ConformanceTarget = {
  readonly url: string
  readonly token: string
}

const textOf = (value: unknown): string => {
  if (value === null || typeof value !== "object" || !("content" in value)) return ""
  const content = value.content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (block !== null && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("")
}

function fail(version: string, detail: string): never {
  throw new Error(`${version}: ${detail}`)
}

const sameList = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && actual.every((version, index) => version === expected[index])

const session = async (target: ConformanceTarget, version: SupportedProtocolVersion) => {
  const modern = (modernProtocolVersions as readonly string[]).includes(version)
  const client = new Client(
    { name: "agent-rooms-conformance", version: "0" },
    modern
      ? { versionNegotiation: { mode: { pin: version } } }
      : { versionNegotiation: { mode: "legacy" }, supportedProtocolVersions: [version] },
  )
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: { authorization: `Bearer ${target.token}` } },
  })
  try {
    await client.connect(transport)
    if (modern) {
      const discovered = client.getDiscoverResult()
      if (discovered === undefined) fail(version, "server/discover returned no result")
      const supported = discovered.supportedVersions
      const instructions = discovered.instructions
      if (!sameList(supported, modernProtocolVersions)) fail(version, `supportedVersions ${supported.join(", ")}`)
      if (instructions !== agentInstructions) fail(version, "discover instructions differ from the guide")
    } else if (client.getInstructions() !== agentInstructions) {
      fail(version, "initialize instructions differ from the guide")
    }
    const listed = await client.listTools()
    if (!listed.tools.some((tool) => tool.name === "whoami")) fail(version, "tools/list omitted whoami")
    const called = await client.callTool({ name: "whoami", arguments: {} })
    if (!textOf(called).includes("\"displayName\"")) fail(version, `whoami returned ${textOf(called)}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${version}:`)) throw error
    fail(version, error instanceof Error ? error.message : String(error))
  } finally {
    await client.close()
  }
}

const postJson = async (url: string, headers: Record<string, string>, body: unknown) => {
  const init = {
    method: "POST",
    headers: { connection: "close", ...headers },
    body: JSON.stringify(body),
  }
  try {
    return await fetch(url, init)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ECONNRESET")) throw error
    return await fetch(url, init)
  }
}

const readJson = async (response: Response) => {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(text)
  }
}

const expectUnauthorized = async (target: ConformanceTarget, version: string) => {
  const response = await postJson(
    target.url,
    { "content-type": "application/json", accept: "application/json, text/event-stream" },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conformance", version: "0" } },
    },
  )
  if (response.status !== 401) fail(version, `missing token returned ${response.status}`)
}

const unsupportedBody = (version: SupportedProtocolVersion) =>
  (modernProtocolVersions as readonly string[]).includes(version)
    ? {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "1900-01-01",
            "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }
    : {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "conformance", version: "0" } },
      }

const expectUnsupported = async (target: ConformanceTarget, version: SupportedProtocolVersion) => {
  const modern = (modernProtocolVersions as readonly string[]).includes(version)
  const response = await postJson(
    target.url,
    {
      authorization: `Bearer ${target.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": modern ? "1900-01-01" : "1999-01-01",
      ...(modern ? { "mcp-method": "server/discover" } : {}),
    },
    unsupportedBody(version),
  )
  let parsed: unknown
  try {
    parsed = await readJson(response)
  } catch (error) {
    fail(version, error instanceof Error ? error.message : String(error))
  }
  if (response.status !== 400) fail(version, `unsupported version returned ${response.status}`)
  if (parsed === null || typeof parsed !== "object" || !("error" in parsed)) fail(version, "unsupported version was not a JSON-RPC error")
  const rpcError = parsed.error
  if (rpcError === null || typeof rpcError !== "object" || !("code" in rpcError) || !("data" in rpcError)) {
    fail(version, "unsupported version error had no data")
  }
  const code = rpcError.code
  const data = rpcError.data
  if (code !== -32022) fail(version, `unsupported version code ${String(code)}`)
  if (data === null || typeof data !== "object" || !("supported" in data) || !Array.isArray(data.supported)) {
    fail(version, "unsupported version omitted supported")
  }
  const supported = data.supported.map(String)
  if (!sameList(supported, supportedProtocolVersions)) fail(version, `supported list ${supported.join(", ")}`)
}

export const runConformance = async (target: ConformanceTarget) => {
  for (const version of supportedProtocolVersions) {
    await session(target, version)
    await expectUnauthorized(target, version)
    await expectUnsupported(target, version)
  }
}

if (import.meta.main) {
  const url = process.env.AGENT_ROOMS_URL
  const token = process.env.AGENT_ROOMS_TOKEN
  if (url === undefined || url.length === 0 || token === undefined || token.length === 0) {
    console.error("Set AGENT_ROOMS_URL and AGENT_ROOMS_TOKEN.")
    process.exit(1)
  }
  const mcp = url.endsWith("/mcp") ? url : `${url.replace(/\/$/, "")}/mcp`
  await runConformance({ url: mcp, token })
}

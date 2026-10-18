import { readFileSync } from "node:fs"
import { supportedProtocolVersions } from "../src/mcp/protocol.ts"

const specUrl = "https://modelcontextprotocol.io/specification/versioning"
const packages = ["@modelcontextprotocol/server", "@modelcontextprotocol/client"] as const

const numbers = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10))

const newer = (latest: string, pinned: string) => {
  const left = numbers(latest)
  const right = numbers(pinned)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (Number.isNaN(left[index] ?? 0) || Number.isNaN(right[index] ?? 0)) return false
    if (delta > 0) return true
    if (delta < 0) return false
  }
  return false
}

function die(message: string): never {
  console.error(message)
  throw new Error(message)
}

export const currentProtocolVersion = (text: string): string | undefined =>
  /current\** protocol version is \[?\**(\d{4}-\d{2}-\d{2})/i.exec(text)?.[1]

const specVersion = async () => {
  const response = await fetch(specUrl, { headers: { accept: "text/markdown" } })
  if (!response.ok) die(`The spec page returned ${response.status}.`)
  const version = currentProtocolVersion(await response.text())
  if (version === undefined) die("The spec page did not name a current protocol version.")
  return version
}

const latestRelease = async (name: string) => {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`, { headers: { accept: "application/json" } })
  if (!response.ok) die(`${name} returned ${response.status}.`)
  const body = (await response.json()) as { version?: unknown }
  if (typeof body.version !== "string") die(`${name} latest has no version.`)
  return body.version
}

if (import.meta.main) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>
  }
  const pinned = packages.map((name) => {
    const version = pkg.dependencies?.[name]
    if (version === undefined) die(`package.json does not depend on ${name}.`)
    return { name, version }
  })
  const current = await specVersion()
  const releases = await Promise.all(pinned.map(async (item) => ({ ...item, latest: await latestRelease(item.name) })))
  const missing = !(supportedProtocolVersions as readonly string[]).includes(current)
  const behind = releases.filter((item) => newer(item.latest, item.version))
  if (!missing && behind.length === 0) {
    console.log(`MCP spec ${current} is supported. SDK pins match the latest release.`)
    process.exit(0)
  }
  if (missing) console.error(`The current MCP protocol version ${current} is not in supportedProtocolVersions.`)
  for (const item of behind) console.error(`${item.name} latest is ${item.latest}; this repo pins ${item.version}.`)
  console.error(`Supported protocol versions: ${supportedProtocolVersions.join(", ")}.`)
  process.exit(2)
}

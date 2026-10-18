import { describe, expect, test } from "bun:test"
import {
  supportedProtocolVersions,
  unsupportedProtocolVersionBody,
  versionRejection,
} from "../src/mcp/protocol.ts"

const message = (value: unknown) => JSON.stringify(value)

describe("versionRejection", () => {
  test("leaves a supported version to the SDK", () => {
    const body = message({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })
    expect(versionRejection(body, "2025-06-18")).toBeUndefined()
  })

  test("rejects when any declared version is unsupported", () => {
    const body = message({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    })
    expect(versionRejection(body, "2025-06-18")).toEqual({ id: 1, requested: "1999-01-01" })
  })

  test("leaves two supported versions that disagree to the SDK", () => {
    const body = message({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })
    expect(versionRejection(body, "2025-11-25")).toBeUndefined()
  })

  test("rejects an unsupported version inside a batch", () => {
    const body = message([
      {
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
    ])
    expect(versionRejection(body, "2025-03-26")).toEqual({ id: 4, requested: "2025-03-26" })
  })

  test("rejects an unsupported initialize version", () => {
    const body = message({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    })
    expect(versionRejection(body, "1999-01-01")).toEqual({ id: 7, requested: "1999-01-01" })
  })

  test("rejects an unsupported modern version", () => {
    const body = message({
      jsonrpc: "2.0",
      id: "a",
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
    })
    expect(versionRejection(body, "1900-01-01")).toEqual({ id: "a", requested: "1900-01-01" })
  })

  test("leaves an unparseable body to the SDK", () => {
    expect(versionRejection("not-json", null)).toBeUndefined()
  })

  test("lists every supported version on the error", () => {
    const body = unsupportedProtocolVersionBody({ id: 1, requested: "1900-01-01" })
    expect(body.error.code).toBe(-32022)
    expect(body.error.message).toBe("Unsupported protocol version")
    expect(body.error.data.supported).toEqual([...supportedProtocolVersions])
    expect(body.error.data.requested).toBe("1900-01-01")
  })
})

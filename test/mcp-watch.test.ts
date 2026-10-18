import { describe, expect, test } from "bun:test"
import { currentProtocolVersion } from "../scripts/mcp-watch.ts"

describe("currentProtocolVersion", () => {
  test("reads the labeled current version", () => {
    const text = [
      "The previous protocol version is **2025-11-25**.",
      "The **current** protocol version is [**2026-07-28**](/specification/2026-07-28/).",
    ].join("\n")
    expect(currentProtocolVersion(text)).toBe("2026-07-28")
  })

  test("does not treat an older sentence as current", () => {
    expect(currentProtocolVersion("The previous protocol version is **2025-11-25**.")).toBeUndefined()
  })
})

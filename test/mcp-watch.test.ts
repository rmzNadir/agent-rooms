import { describe, expect, test } from "bun:test";
import { currentProtocolVersion, newer } from "../scripts/mcp-watch.ts";

describe("currentProtocolVersion", () => {
  test("reads the labeled current version", () => {
    const text = [
      "The previous protocol version is **2025-11-25**.",
      "The **current** protocol version is [**2026-07-28**](/specification/2026-07-28/).",
    ].join("\n");
    expect(currentProtocolVersion(text)).toBe("2026-07-28");
  });

  test("treats a higher package version as newer and an equal one as not", () => {
    expect(newer("2.3.2", "2.3.1")).toBe(true);
    expect(newer("2.4", "2.3.1")).toBe(true);
    expect(newer("2.3.1", "2.3.1")).toBe(false);
    expect(newer("2.3.0", "2.3.1")).toBe(false);
    expect(newer("2.3.1", "2.3.1.1")).toBe(false);
  });

  test("does not treat an older sentence as current", () => {
    expect(
      currentProtocolVersion("The previous protocol version is **2025-11-25**.")
    ).toBeUndefined();
  });
});

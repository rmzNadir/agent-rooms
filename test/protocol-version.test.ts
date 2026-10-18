import { describe, expect, test } from "bun:test";
import type { Json } from "effect/Schema";
import {
  modernProtocolVersions,
  supportedProtocolVersions,
  unsupportedProtocolVersionBody,
  versionRejection,
} from "../src/mcp/protocol.ts";

const message = (value: Json) => JSON.stringify(value);

describe("versionRejection", () => {
  test("leaves a supported version to the SDK", () => {
    const body = message({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(versionRejection(body, "2025-06-18")).toBeUndefined();
  });

  test("rejects when any declared version is unsupported", () => {
    const body = message({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(body, "2025-06-18")).toEqual({
      id: 1,
      requested: "1999-01-01",
    });
  });

  test("leaves two supported versions that disagree to the SDK", () => {
    const body = message({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(versionRejection(body, "2025-11-25")).toBeUndefined();
  });

  test("rejects an unsupported version inside a batch", () => {
    const body = message([
      {
        id: 4,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
    ]);
    expect(versionRejection(body, "2025-03-26")).toEqual({
      id: 4,
      requested: "2025-03-26",
    });
  });

  test("rejects an unsupported initialize version", () => {
    const body = message({
      id: 7,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(body, "1999-01-01")).toEqual({
      id: 7,
      requested: "1999-01-01",
    });
  });

  test("rejects an unsupported modern version", () => {
    const body = message({
      id: "a",
      jsonrpc: "2.0",
      method: "server/discover",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
      },
    });
    expect(versionRejection(body, "1900-01-01")).toEqual({
      id: "a",
      requested: "1900-01-01",
    });
  });

  test("leaves an unparseable body to the SDK", () => {
    expect(versionRejection("not-json", null)).toBeUndefined();
  });

  test("lists every supported version on the error", () => {
    const body = unsupportedProtocolVersionBody({
      id: 1,
      requested: "1900-01-01",
    });
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32_022);
    expect(body.error.message).toBe("Unsupported protocol version");
    expect(body.error.data.supported).toEqual([
      "2026-07-28",
      "2025-11-25",
      "2025-06-18",
    ]);
    expect(body.error.data.requested).toBe("1900-01-01");
    expect(supportedProtocolVersions).toEqual([
      "2026-07-28",
      "2025-11-25",
      "2025-06-18",
    ]);
    expect(modernProtocolVersions).toEqual(["2026-07-28"]);
  });

  test("rejects an unsupported meta version when the header is absent", () => {
    const body = message({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
      },
    });
    expect(versionRejection(body, null)).toEqual({
      id: null,
      requested: "1900-01-01",
    });
  });

  test("keeps a supported meta version", () => {
    const body = message({
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    });
    expect(versionRejection(body, null)).toBeUndefined();
  });

  test("treats boolean, object, and missing ids as absent", () => {
    const body = message({
      id: true,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(body, null)).toEqual({
      id: null,
      requested: "1999-01-01",
    });
    const objectId = message({
      id: { n: 1 },
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(objectId, null)).toEqual({
      id: null,
      requested: "1999-01-01",
    });
    const missing = message({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(missing, null)).toEqual({
      id: null,
      requested: "1999-01-01",
    });
    const zero = message({
      id: 0,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(zero, null)).toEqual({
      id: 0,
      requested: "1999-01-01",
    });
  });

  test("ignores protocol versions that are not text", () => {
    const numeric = message({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: 2025 },
    });
    const listed = message({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: ["1999-01-01"] },
    });
    const empty = message({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "" },
    });
    expect(versionRejection(numeric, null)).toBeUndefined();
    expect(versionRejection(listed, null)).toBeUndefined();
    expect(versionRejection(empty, null)).toBeUndefined();
  });

  test("ignores a non-object body", () => {
    expect(versionRejection("1", "1999-01-01")).toBeUndefined();
    expect(versionRejection("null", "1999-01-01")).toBeUndefined();
    expect(versionRejection("true", "1999-01-01")).toBeUndefined();
    expect(versionRejection('"1999-01-01"', "1999-01-01")).toBeUndefined();
  });

  test("ignores params and meta that are not objects", () => {
    const params = message({
      jsonrpc: "2.0",
      method: "initialize",
      params: null,
    });
    const meta = message({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { _meta: null },
    });
    const metaList = message({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { _meta: ["1900-01-01"] },
    });
    expect(versionRejection(params, null)).toBeUndefined();
    expect(versionRejection(meta, null)).toBeUndefined();
    expect(versionRejection(metaList, null)).toBeUndefined();
  });

  test("reads protocolVersion only from initialize", () => {
    const body = message({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(body, null)).toBeUndefined();
    const bare = message({ jsonrpc: "2.0", method: "initialize" });
    expect(versionRejection(bare, null)).toBeUndefined();
  });

  test("prefers an unsupported header over a supported body", () => {
    const body = message({
      id: 2,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(versionRejection(body, "1999-01-01")).toEqual({
      id: 2,
      requested: "1999-01-01",
    });
    const unsupported = message({
      id: 2,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(versionRejection(unsupported, "")).toEqual({
      id: 2,
      requested: "1999-01-01",
    });
  });

  test("returns the later rejection in a batch", () => {
    const body = message([
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      1,
      {
        id: 9,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      },
    ]);
    expect(versionRejection(body, null)).toEqual({
      id: 9,
      requested: "1999-01-01",
    });
    expect(versionRejection("[]", null)).toBeUndefined();
  });
});

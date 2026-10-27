import { describe, expect, test } from "bun:test";
import type { CfCall } from "../scripts/http-text.ts";
import {
  findZoneName,
  zoneCandidates,
  zoneFailure,
} from "../scripts/zone-lookup.ts";

const reply = (status: number, text: string) => ({ status, text });

const zones = (rows: readonly { account: string; name: string }[]): CfCall => {
  const calls: string[] = [];
  const call: CfCall = (method, path) => {
    calls.push(`${method} ${path}`);
    const name = new URL(`https://api.cloudflare.com${path}`).searchParams.get(
      "name"
    );
    const row = rows.find((item) => item.name === name);
    const result =
      row === undefined
        ? []
        : [{ account: { id: row.account }, name: row.name }];
    return Promise.resolve(
      reply(200, JSON.stringify({ result, success: true }))
    );
  };
  return call;
};

describe("zone lookup", () => {
  test("walks parent labels and keeps the longest zone on the account", async () => {
    expect(zoneCandidates("rooms.ce.systems")).toEqual([
      "rooms.ce.systems",
      "ce.systems",
    ]);
    const found = await findZoneName(
      zones([
        { account: "account-a", name: "ce.systems" },
        { account: "account-b", name: "rooms.ce.systems" },
      ]),
      "account-a",
      "rooms.ce.systems"
    );
    expect(found).toBe("ce.systems");
    expect(zoneFailure("rooms.ce.systems")).toContain(
      "Cloudflare zone not found for rooms.ce.systems"
    );
    expect(zoneFailure("rooms.ce.systems")).toContain("DNS Write");
  });

  test("fails closed when the token cannot read the zone", async () => {
    const denied: CfCall = () => Promise.resolve(reply(403, "no"));
    await expect(
      findZoneName(denied, "account-a", "rooms.example.com")
    ).rejects.toThrow("Zone Read is missing for rooms.example.com");
    const missing: CfCall = () =>
      Promise.resolve(
        reply(200, JSON.stringify({ result: [], success: true }))
      );
    await expect(
      findZoneName(missing, "account-a", "rooms.example.com")
    ).resolves.toBeUndefined();
    const broken: CfCall = () => Promise.resolve(reply(500, "down"));
    await expect(
      findZoneName(broken, "account-a", "rooms.example.com")
    ).rejects.toThrow("zone lookup failed 500");
  });
});

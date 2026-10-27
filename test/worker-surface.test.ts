import { describe, expect, test } from "bun:test";
import {
  deployInput,
  deploySurface,
  domainProblem,
  pinnedScriptName,
  publicBase,
  scriptNameFromUrl,
} from "../src/runtime/worker-surface.ts";

const live = {
  dev: false,
  domain: undefined,
  localState: false,
  url: "https://agentrooms-api-nadir-example.account.workers.dev",
  workerName: undefined,
};

describe("worker surface", () => {
  test("reads a workers.dev script name and ignores other hosts", () => {
    expect(scriptNameFromUrl("https://api.example.workers.dev/mcp")).toBe(
      "api"
    );
    expect(scriptNameFromUrl("https://rooms.example")).toBeUndefined();
    expect(scriptNameFromUrl("not a url")).toBeUndefined();
    expect(scriptNameFromUrl("https://.workers.dev")).toBeUndefined();
    expect(scriptNameFromUrl("https://workers.dev")).toBeUndefined();
    expect(() => scriptNameFromUrl(undefined)).toThrow("script url");
  });

  test("pins the workers.dev name ahead of the override", () => {
    expect(pinnedScriptName("https://api.example.workers.dev", "other")).toBe(
      "api"
    );
    expect(pinnedScriptName("https://rooms.example", "Api")).toBe("Api");
    expect(pinnedScriptName(undefined, undefined)).toBeUndefined();
    expect(pinnedScriptName("", undefined)).toBeUndefined();
    expect(pinnedScriptName(undefined, "")).toBeUndefined();
  });

  test("rejects a domain that is not a bare hostname", () => {
    expect(domainProblem(undefined)).toBeUndefined();
    expect(domainProblem("rooms.example.com")).toBeUndefined();
    expect(domainProblem("rooms.ce.systems")).toBeUndefined();
    expect(domainProblem("api.example.workers.dev")).toBe(
      "AGENT_ROOMS_DOMAIN must not be a workers.dev host"
    );
    expect(domainProblem("workers.dev")).toBe(
      "AGENT_ROOMS_DOMAIN must not be a workers.dev host"
    );
    expect(domainProblem("https://rooms.example.com")).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
    expect(domainProblem("rooms.example.com/mcp")).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
    expect(domainProblem("rooms.example.com:443")).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
    expect(domainProblem("Rooms.Example.com")).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
    expect(domainProblem("a.co")).toBeUndefined();
    expect(domainProblem("ab.co.d")).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
    const label = "a".repeat(63);
    const exactHost = `${label}.${label}.${label}.${"b".repeat(61)}`;
    expect(exactHost.length).toBe(253);
    expect(domainProblem(exactHost)).toBeUndefined();
    expect(domainProblem(` ${"ab.".repeat(90)}com`)).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
    const longHost = `${Array.from({ length: 120 }, () => "ab").join(".")}.com`;
    expect(longHost.length).toBeGreaterThan(253);
    expect(domainProblem(longHost)).toBe(
      "AGENT_ROOMS_DOMAIN must be a bare hostname"
    );
  });

  test("uses the domain as the public base when it is valid", () => {
    expect(publicBase("rooms.example.com", "https://old.example")).toBe(
      "https://rooms.example.com"
    );
    expect(publicBase(undefined, "https://old.example")).toBe(
      "https://old.example"
    );
    expect(publicBase("https://bad.example", "https://old.example")).toBe(
      "https://old.example"
    );
    expect(publicBase(undefined, undefined)).toBeUndefined();
    expect(publicBase("", "")).toBeUndefined();
  });

  test("pins a live script and omits the domain until it is set", () => {
    const pinned = deploySurface(live);
    expect(pinned).toEqual({
      name: "agentrooms-api-nadir-example",
    });
    expect(Object.hasOwn(pinned, "domain")).toBe(false);
    expect(
      Object.hasOwn(deploySurface({ ...live, url: undefined }), "name")
    ).toBe(false);
    expect(deploySurface({ ...live, domain: "rooms.example.com" })).toEqual({
      domain: "rooms.example.com",
      name: "agentrooms-api-nadir-example",
    });
    expect(
      deploySurface({ ...live, dev: true, domain: "rooms.example.com" })
    ).toEqual({});
    expect(
      deploySurface({ ...live, domain: "rooms.example.com", localState: true })
    ).toEqual({});
    expect(
      deploySurface({
        ...live,
        url: undefined,
        workerName: "kept-script",
      })
    ).toEqual({ name: "kept-script" });
    expect(() =>
      deploySurface({ ...live, domain: "api.example.workers.dev" })
    ).toThrow("AGENT_ROOMS_DOMAIN must not be a workers.dev host");
  });

  test("reads the deploy environment", () => {
    const read =
      (values: Record<string, string | undefined>) => (name: string) =>
        values[name];
    expect(
      deployInput(
        read({
          AGENT_ROOMS_DOMAIN: "rooms.example.com",
          AGENT_ROOMS_LOCAL_STATE: "1",
          AGENT_ROOMS_URL: "https://api.example.workers.dev",
          AGENT_ROOMS_WORKER_NAME: "kept-script",
          ALCHEMY_DEV: "true",
        })
      )
    ).toEqual({
      dev: true,
      domain: "rooms.example.com",
      localState: true,
      url: "https://api.example.workers.dev",
      workerName: "kept-script",
    });
    expect(deployInput(read({})).dev).toBe(false);
    expect(deployInput(read({ ALCHEMY_DEV: "false" })).dev).toBe(false);
    expect(deployInput(read({})).localState).toBe(false);
    expect(deployInput(read({ AGENT_ROOMS_LOCAL_STATE: "0" })).localState).toBe(
      false
    );
    expect(deployInput(read({})).domain).toBeUndefined();
    expect(deployInput(read({})).url).toBeUndefined();
    expect(deployInput(read({})).workerName).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  accountPath,
  accountSubdomain,
  deleteObject,
  deleteScript,
  deploymentList,
  enableSubdomain,
  ensureBucket,
  listKeys,
  listQuery,
  objectKeyPath,
  pinnedVersion,
  putObject,
  retainPrefix,
  rollBack,
  scriptPath,
} from "../scripts/cf-client.ts";
import type { CfCall } from "../scripts/http-text.ts";

const ok = (text: string, status = 200) => ({ status, text });

const later = (text: string, status = 200) => Promise.resolve(ok(text, status));

const createsBucket = (method: string, path: string) =>
  method === "POST" && path.endsWith("/r2/buckets");

const storedObject = (
  method: string,
  path: string
): ReturnType<typeof later> | undefined => {
  if (createsBucket(method, path)) {
    return later(
      '{"success":false,"errors":[{"message":"Already exists"}]}',
      400
    );
  }
  if (method === "PUT") {
    return later("{}");
  }
  return undefined;
};

const listedKeys = (
  method: string,
  gets: number
): ReturnType<typeof later> | undefined => {
  if (method !== "GET") {
    return undefined;
  }
  if (gets === 1) {
    return later(
      '{"success":true,"result":[{"key":"nightly/2020-01-01.json"}],"result_info":{"cursor":"next"}}'
    );
  }
  return later(
    '{"success":true,"result":[{"key":"nightly/2026-10-19.json"},{"key":"notes/keep"}]}'
  );
};

const deploymentGet = (path: string, live: string) => {
  if (path.endsWith("/missing/deployments")) {
    return later("", 404);
  }
  if (path.includes("/bad/")) {
    return later('{"success":false,"errors":[{"message":"denied"}]}', 403);
  }
  if (path.includes("/split/")) {
    return later(
      '{"success":true,"result":{"deployments":[{"created_on":"2026-10-19T00:00:00Z","versions":[{"percentage":40,"version_id":"half"}]}]}}'
    );
  }
  return later(live);
};

const forcedRollback = (method: string, path: string) =>
  method === "POST" && path.includes("force=true");

const deleteStatus = (path: string) => {
  if (path.includes("missing")) {
    return 404;
  }
  return 200;
};

describe("cloudflare paths", () => {
  test("keeps slashes in object keys and encodes the rest", () => {
    expect(objectKeyPath("acc", "bucket", "deploy/file name.json")).toBe(
      "/accounts/acc/r2/buckets/bucket/objects/deploy/file%20name.json"
    );
    expect(scriptPath("acc", "a/b", "/deployments")).toBe(
      "/accounts/acc/workers/scripts/a%2Fb/deployments"
    );
    expect(accountPath("a b", "/r2/buckets")).toBe(
      "/accounts/a%20b/r2/buckets"
    );
    expect(listQuery("deploy/", "")).toContain("prefix=deploy%2F");
    expect(listQuery("deploy/", "cursor")).toContain("cursor=cursor");
  });

  test("creates a bucket, stores an object, and prunes old keys", async () => {
    const calls: string[] = [];
    const call: CfCall = (method, path, body) => {
      calls.push(`${method} ${path} ${body ?? ""}`);
      const wrote = storedObject(method, path);
      if (wrote !== undefined) {
        return wrote;
      }
      const gets = calls.filter((item) => item.startsWith("GET")).length;
      return listedKeys(method, gets) ?? later("{}");
    };
    await ensureBucket(call, "acc", "backups");
    await putObject(call, "acc", "backups", "deploy/a.json", "body");
    const removed = await retainPrefix(
      call,
      "acc",
      "backups",
      "nightly/",
      Date.parse("2026-10-19T00:00:00Z")
    );
    expect(removed).toBe(1);
    expect(
      calls.some((item) => item.includes("nightly%2F2020-01-01.json"))
    ).toBe(false);
    expect(calls.some((item) => item.includes("nightly/2020-01-01.json"))).toBe(
      true
    );
    expect(calls.some((item) => item.includes("backups"))).toBe(true);
    expect(calls.some((item) => item.includes("deploy/a.json body"))).toBe(
      true
    );
  });

  test("stops listing at the page cap and surfaces api failures", async () => {
    let pages = 0;
    const call: CfCall = (method) => {
      pages += 1;
      if (method === "DELETE") {
        return Promise.resolve(ok("nope", 500));
      }
      return Promise.resolve(
        ok(
          `{"success":true,"result":[{"key":"deploy/${pages}.json"}],"result_info":{"cursor":"c${pages}"}}`
        )
      );
    };
    await expect(listKeys(call, "acc", "bucket", "deploy/")).rejects.toThrow(
      "r2 list exceeded page cap"
    );
    await expect(deleteObject(call, "acc", "bucket", "a")).rejects.toThrow(
      "r2 delete failed 500"
    );
    const down: CfCall = () => Promise.resolve(ok("nope", 500));
    await expect(ensureBucket(down, "acc", "bucket")).rejects.toThrow(
      "cloudflare request failed"
    );
    await expect(
      putObject(down, "acc", "bucket", "a", "SECRET_BODY")
    ).rejects.toThrow("r2 put failed 500");
  });

  test("pins, rolls back, and deletes a missing script", async () => {
    const live = JSON.stringify({
      result: {
        deployments: [
          {
            created_on: "2026-10-19T00:00:00Z",
            versions: [{ percentage: 100, version_id: "ver-live" }],
          },
        ],
      },
      success: true,
    });
    const call: CfCall = (method, path, body) => {
      if (method === "GET") {
        return deploymentGet(path, live);
      }
      if (forcedRollback(method, path)) {
        expect(body).toContain("ver-live");
        return later("{}", 500);
      }
      if (method === "DELETE") {
        return later("", deleteStatus(path));
      }
      return later(live);
    };
    expect(await deploymentList(call, "acc", "missing")).toEqual([]);
    await expect(deploymentList(call, "acc", "bad")).rejects.toThrow(
      "deployments failed 403"
    );
    expect(await pinnedVersion(call, "acc", "Api")).toBe("ver-live");
    expect(await pinnedVersion(call, "acc", "missing")).toBeUndefined();
    await expect(pinnedVersion(call, "acc", "split")).rejects.toThrow(
      "100 percent"
    );
    await expect(rollBack(call, "acc", "Api", "ver-live")).rejects.toThrow(
      "rollback failed 500"
    );
    const posted: CfCall = (method, path, body) => {
      expect(method).toBe("POST");
      expect(path).toContain("force=true");
      expect(body).toContain("ver-live");
      return Promise.resolve(ok("{}"));
    };
    await rollBack(posted, "acc", "Api", "ver-live");
    await deleteScript(call, "acc", "missing");
    await deleteScript(call, "acc", "present");
    const denied: CfCall = () => Promise.resolve(ok("", 500));
    await expect(deleteScript(denied, "acc", "present")).rejects.toThrow(
      "receiver delete failed 500"
    );
  });

  test("enables the receiver subdomain", async () => {
    const call: CfCall = (method, path) => {
      if (method === "POST") {
        expect(path).toContain("/subdomain");
        return Promise.resolve(ok("{}"));
      }
      return Promise.resolve(
        ok('{"success":true,"result":{"subdomain":"nadir"}}')
      );
    };
    await enableSubdomain(call, "acc", "receiver");
    expect(await accountSubdomain(call, "acc")).toBe("nadir");
    const down: CfCall = (method) =>
      Promise.resolve(ok("{}", method === "POST" ? 500 : 200));
    await expect(enableSubdomain(down, "acc", "receiver")).rejects.toThrow(
      "receiver subdomain failed 500"
    );
    await expect(accountSubdomain(down, "acc")).rejects.toThrow(
      "workers subdomain failed 200"
    );
  });
});

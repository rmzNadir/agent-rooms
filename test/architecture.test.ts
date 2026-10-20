import { expect, test } from "bun:test";
import { architectureFailures } from "../scripts/architecture.ts";
import { roomsOnCloudflare } from "../src/runtime/domain-host.ts";

test("domain modules stay inside the model and the guidance links stay symlinks", () => {
  expect(architectureFailures()).toEqual([]);
  expect(typeof roomsOnCloudflare().pipe).toBe("function");
});

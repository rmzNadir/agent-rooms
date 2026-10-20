import { expect, test } from "bun:test";
import { decideAdmin } from "../src/domain/admin-auth.ts";

test("the env token bootstraps once and stops working after the stored hash changes", () => {
  expect(
    decideAdmin({ envHash: "env", presentedHash: "env", storedHash: undefined })
  ).toBe("bootstrap");
  expect(
    decideAdmin({
      envHash: "env",
      presentedHash: "nope",
      storedHash: undefined,
    })
  ).toBe("reject");
  expect(
    decideAdmin({ envHash: "env", presentedHash: "env", storedHash: "env" })
  ).toBe("accept");
  expect(
    decideAdmin({ envHash: "env", presentedHash: "env", storedHash: "rotated" })
  ).toBe("reject");
  expect(
    decideAdmin({
      envHash: "env",
      presentedHash: "rotated",
      storedHash: "rotated",
    })
  ).toBe("accept");
  expect(
    decideAdmin({
      envHash: "env",
      presentedHash: "other",
      storedHash: "rotated",
    })
  ).toBe("reject");
});

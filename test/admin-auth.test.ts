import { expect, test } from "bun:test"
import { decideAdmin } from "../src/domain/admin-auth.ts"

test("the env token bootstraps once and stops working after the stored hash changes", () => {
  expect(decideAdmin({ presentedHash: "env", envHash: "env", storedHash: undefined })).toBe("bootstrap")
  expect(decideAdmin({ presentedHash: "env", envHash: "env", storedHash: "env" })).toBe("accept")
  expect(decideAdmin({ presentedHash: "env", envHash: "env", storedHash: "rotated" })).toBe("reject")
  expect(decideAdmin({ presentedHash: "rotated", envHash: "env", storedHash: "rotated" })).toBe("accept")
  expect(decideAdmin({ presentedHash: "other", envHash: "env", storedHash: "rotated" })).toBe("reject")
})

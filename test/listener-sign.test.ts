import { createHmac } from "node:crypto"
import { expect, test } from "bun:test"
import { verifySignature } from "../listeners/common.mjs"

test("accepts a fresh HMAC and rejects a mismatch", () => {
  const secret = "sek"
  const timestamp = String(Date.now())
  const body = "{\"roomId\":\"room_abcdefghijklmnopqrstuvwx\"}"
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  expect(verifySignature(secret, timestamp, body, `sha256=${signature}`)).toBe(true)
  expect(verifySignature(secret, timestamp, body, "sha256=00")).toBe(false)
  expect(verifySignature(secret, "1", body, `sha256=${signature}`)).toBe(false)
})

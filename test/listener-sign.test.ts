import { createHmac } from "node:crypto"
import { expect, test } from "bun:test"
import { rememberSignature, verifySignature } from "../listeners/common.mjs"

test("accepts a fresh HMAC and rejects a mismatch", () => {
  const secret = "sek"
  const timestamp = String(Date.now())
  const body = "{\"roomId\":\"room_abcdefghijklmnopqrstuvwx\"}"
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  expect(verifySignature(secret, timestamp, body, `sha256=${signature}`)).toBe(true)
  expect(verifySignature(secret, timestamp, body, "sha256=00")).toBe(false)
  expect(verifySignature(secret, "1", body, `sha256=${signature}`)).toBe(false)
})

test("accepts one copy of a signature and rejects the replay", () => {
  const seen = new Map()
  const now = Date.now()
  const signature = "sha256=abc"
  expect(rememberSignature(seen, signature, now)).toBe(true)
  expect(rememberSignature(seen, signature, now + 1_000)).toBe(false)
  expect(rememberSignature(seen, signature, now + 5 * 60 * 1000 + 1)).toBe(true)
})

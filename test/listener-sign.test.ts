import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  rememberSignature,
  signatureDigest,
  verifySignature,
} from "../listeners/listener-io.mjs";

test("accepts a fresh HMAC and rejects a mismatch", () => {
  const secret = "sek";
  const timestamp = String(Date.now());
  const body = '{"roomId":"room_abcdefghijklmnopqrstuvwx"}';
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  expect(verifySignature(secret, timestamp, body, `sha256=${signature}`)).toBe(
    true
  );
  expect(verifySignature(secret, timestamp, body, "sha256=00")).toBe(false);
  expect(verifySignature(secret, "1", body, `sha256=${signature}`)).toBe(false);
});

test("treats the sha256 prefix as the same digest", () => {
  expect(signatureDigest("sha256=AbC")).toBe("abc");
  expect(signatureDigest("AbC")).toBe("abc");
  const seen = new Map();
  const digest = signatureDigest("sha256=AbC");
  expect(rememberSignature(seen, digest, Date.now())).toBe(true);
  expect(rememberSignature(seen, signatureDigest("AbC"), Date.now())).toBe(
    false
  );
});

test("accepts one copy of a signature and rejects the replay", () => {
  const seen = new Map();
  const now = Date.now();
  const signature = "sha256=abc";
  expect(rememberSignature(seen, signature, now)).toBe(true);
  expect(rememberSignature(seen, signature, now + 1000)).toBe(false);
  expect(rememberSignature(seen, signature, now + 5 * 60 * 1000 + 1)).toBe(
    true
  );
});

import { Effect, Schema } from "effect";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

export const hashToken = Effect.fn("Token.hash")(function* (token: string) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  );
  return hex(digest);
});

export const makeSecret = Effect.fn("Token.secret")(function* () {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
});

export const importSigningKey = (secret: string, extractable: boolean) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    extractable,
    ["sign"]
  );

export const signingKeyDefect = "signing key must stay non-extractable";

export const rejectExtractable = (key: CryptoKey) => {
  if (key.extractable) {
    return Effect.die(new Error(signingKeyDefect));
  }
  return Effect.void;
};

export const signPayload = Effect.fn("Token.sign")(function* (
  secret: string,
  timestamp: string,
  body: string
) {
  const key = yield* Effect.promise(() => importSigningKey(secret, false));
  yield* rejectExtractable(key);
  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`)
    )
  );
  return hex(signature);
});

export const decodeStoredJson = (text: string) => decodeJson(text);

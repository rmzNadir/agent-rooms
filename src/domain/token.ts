import { Effect, Schema } from "effect"

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("")

export const hashToken = Effect.fn("Token.hash")(function* (token: string) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    catch: (cause) => cause,
  }).pipe(Effect.orDie)
  return hex(digest)
})

export const makeSecret = Effect.fn("Token.secret")(function* () {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")
})

export const signPayload = Effect.fn("Token.sign")(function* (
  secret: string,
  timestamp: string,
  body: string,
) {
  const key = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    catch: (cause) => cause,
  }).pipe(Effect.orDie)
  const signature = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)),
    catch: (cause) => cause,
  }).pipe(Effect.orDie)
  return hex(signature)
})

export const decodeStoredJson = (text: string) => decodeJson(text)

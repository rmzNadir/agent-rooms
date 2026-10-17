import { expect, test } from "bun:test"
import { HttpServerRequest } from "effect/http"
import { isHttps } from "../src/api/request-url.ts"

test("an https Worker request is https even though url drops the scheme", () => {
  const request = HttpServerRequest.fromWeb(new Request("https://rooms.example.workers.dev/viewer/session", { method: "POST" }))
  expect(request.url.startsWith("https://")).toBe(false)
  expect(isHttps(request)).toBe(true)
})

test("a plain http request is not https", () => {
  expect(isHttps(HttpServerRequest.fromWeb(new Request("http://localhost:1337/viewer/session")))).toBe(false)
})

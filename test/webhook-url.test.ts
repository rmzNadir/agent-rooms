import { describe, expect, test } from "bun:test"
import { WebhookRegistration } from "../src/directory/directory-http-api.ts"
import { webhookUrlProblem } from "../src/domain/webhook-url.ts"

describe("webhookUrlProblem", () => {
  test("allows public https and loopback http", () => {
    expect(webhookUrlProblem("https://listener.example/wake")).toBeUndefined()
    expect(webhookUrlProblem("http://127.0.0.1:8788/wake")).toBeUndefined()
    expect(webhookUrlProblem("http://localhost:8788/wake")).toBeUndefined()
    expect(webhookUrlProblem("http://[::1]:8788/wake")).toBeUndefined()
  })

  test("rejects private addresses, plaintext public http, and credentials", () => {
    expect(webhookUrlProblem("http://169.254.169.254/latest")).toBe(
      "must not target a private or link-local address",
    )
    expect(webhookUrlProblem("https://10.1.2.3/hook")).toBe("must not target a private or link-local address")
    expect(webhookUrlProblem("https://192.168.1.9/hook")).toBe("must not target a private or link-local address")
    expect(webhookUrlProblem("http://listener.example/wake")).toBe("must be https, or http on localhost")
    expect(webhookUrlProblem("https://user:sek@listener.example/wake")).toBe(
      "must not include a username or password",
    )
    expect(webhookUrlProblem("http://[::ffff:169.254.169.254]/")).toBe(
      "must not target a private or link-local address",
    )
    expect(webhookUrlProblem("https://2130706433/")).toBeUndefined()
  })

  test("the public registration omits the signing secret", () => {
    const text = JSON.stringify(
      new WebhookRegistration({ webhookUrl: "https://listener.example/wake", roomIds: [] }),
    )
    expect(text).toContain("https://listener.example/wake")
    expect(text).not.toContain("webhookSecret")
  })
})

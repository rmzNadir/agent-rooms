import { describe, expect, test } from "bun:test";
import { WebhookRegistration } from "../src/app/records.ts";
import { webhookUrlProblem } from "../src/domain/webhook-url.ts";

describe("webhookUrlProblem", () => {
  test("allows public https and loopback http", () => {
    expect(webhookUrlProblem("https://listener.example/wake")).toBeUndefined();
    expect(webhookUrlProblem("http://127.0.0.1:8788/wake")).toBeUndefined();
    expect(webhookUrlProblem("http://localhost:8788/wake")).toBeUndefined();
    expect(webhookUrlProblem("http://[::1]:8788/wake")).toBeUndefined();
  });

  test("rejects private addresses, plaintext public http, and credentials", () => {
    const privateAddress = "must not target a private or link-local address";
    for (const host of [
      "169.254.169.254",
      "169.254.0.1",
      "10.1.2.3",
      "10.0.0.1",
      "192.168.1.9",
      "192.168.0.1",
      "0.0.0.0",
      "127.0.0.2",
      "172.16.0.1",
      "172.31.0.1",
      "100.64.0.1",
      "100.127.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(webhookUrlProblem(`https://${host}/hook`)).toBe(privateAddress);
    }
    expect(webhookUrlProblem("http://169.254.169.254/latest")).toBe(
      privateAddress
    );
    expect(webhookUrlProblem("http://listener.example/wake")).toBe(
      "must be https, or http on localhost"
    );
    expect(webhookUrlProblem("https://user:sek@listener.example/wake")).toBe(
      "must not include a username or password"
    );
    expect(webhookUrlProblem("http://[::ffff:169.254.169.254]/")).toBe(
      "must not target a private or link-local address"
    );
    expect(webhookUrlProblem("https://2130706433/")).toBe(
      "must be http on localhost"
    );
    expect(webhookUrlProblem("https://127.0.0.1/wake")).toBe(
      "must be http on localhost"
    );
    expect(webhookUrlProblem("https://localhost/wake")).toBe(
      "must be http on localhost"
    );
    expect(webhookUrlProblem("https://user@listener.example/wake")).toBe(
      "must not include a username or password"
    );
    expect(webhookUrlProblem("https://:sek@listener.example/wake")).toBe(
      "must not include a username or password"
    );
    expect(webhookUrlProblem("not a url")).toBe("must be an http or https URL");
    for (const host of [
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.167.0.1",
      "169.253.0.1",
      "100.63.0.1",
      "100.128.0.1",
      "223.0.0.1",
      "1.1.1.1",
      "8.254.1.1",
      "8.20.1.1",
      "8.168.1.1",
      "8.80.1.1",
    ]) {
      expect(webhookUrlProblem(`https://${host}/hook`)).toBeUndefined();
    }
  });

  test("the public registration omits the signing secret", () => {
    const text = JSON.stringify(
      new WebhookRegistration({
        roomIds: [],
        webhookUrl: "https://listener.example/wake",
      })
    );
    expect(text).toContain("https://listener.example/wake");
    expect(text).not.toContain("webhookSecret");
  });
});

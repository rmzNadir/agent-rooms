import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runAgents, setWebhook } from "../scripts/agents.ts";
import { readEnv } from "../src/boundary/external.ts";
import { restoreEnv } from "./restore-env.ts";

test("the agent cli prints usage when the worker url is missing", async () => {
  const key = "AGENT_ROOMS_URL";
  const previous = readEnv(key);
  delete process.env[key];
  const lines: string[] = [];
  const write = console.log;
  console.log = (message: string) => {
    lines.push(message);
  };
  try {
    await Effect.runPromise(runAgents);
  } finally {
    console.log = write;
    restoreEnv(key, previous);
  }
  expect(lines.join("\n")).toContain("Usage:");
});

test("webhook refuses to run without an id, url, and token", async () => {
  const key = "AGENT_ROOMS_TOKEN";
  const token = readEnv(key);
  delete process.env[key];
  try {
    await expect(Effect.runPromise(setWebhook())).rejects.toThrow("Usage:");
  } finally {
    restoreEnv(key, token);
  }
});

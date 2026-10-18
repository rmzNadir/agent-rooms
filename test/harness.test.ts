import { expect, test } from "bun:test";
import {
  codexArgs,
  findSessionId,
  spawnHarness,
} from "../listeners/listener-io.mjs";

test("a harness that reads stdin still exits", async () => {
  const result = await Promise.race([
    spawnHarness({
      args: ["-c", "cat > /dev/null; echo done"],
      bin: "sh",
      cwd: ".",
      env: {},
    }),
    new Promise<{ status: number }>((resolve) =>
      setTimeout(() => resolve({ status: 0 }), 3000)
    ),
  ]);
  expect(result.status).toBe(200);
});

test("claude json output carries the session id", () => {
  expect(findSessionId('{"type":"result","session_id":"ses_claude"}')).toBe(
    "ses_claude"
  );
});

test("codex --json output carries the thread id", () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"01a14870-2655-7ee3-8421-2b8f2b88b225"}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed"}',
  ].join("\n");
  expect(findSessionId(stdout)).toBe("01a14870-2655-7ee3-8421-2b8f2b88b225");
});

test("output with no session id yields none", () => {
  expect(findSessionId("plain text answer")).toBeUndefined();
  expect(findSessionId("")).toBeUndefined();
});

test("codex runs with --json, and resumes a recorded session", () => {
  expect(codexArgs(["-m", "x"], undefined, "hi")).toEqual([
    "-m",
    "x",
    "exec",
    "--json",
    "hi",
  ]);
  expect(codexArgs([], "ses_1", "hi")).toEqual([
    "exec",
    "resume",
    "--json",
    "ses_1",
    "hi",
  ]);
});

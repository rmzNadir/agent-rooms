import { expect, test } from "bun:test";
import { loadConfig } from "../listeners/listener-io.mjs";
import { markDelivered } from "../listeners/listener-wake.mjs";
import { readEnv, writeEnv } from "../src/boundary/external.ts";
import { closeServer, listenLoopback, postedBodies } from "./loopback.ts";
import { restoreEnv } from "./restore-env.ts";

test("loadConfig reads the listen address from the environment", () => {
  const previous = readEnv("AGENT_ROOMS_LISTEN");
  writeEnv("AGENT_ROOMS_LISTEN", "127.0.0.1:8799");
  const config = loadConfig();
  restoreEnv("AGENT_ROOMS_LISTEN", previous);
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(8799);
});

test("markDelivered posts mark_read for the delivered seq", async () => {
  const { bodies, server } = postedBodies();
  const port = await listenLoopback(server);
  await markDelivered(
    {
      bearerToken: "token",
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
    },
    { roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaa", toSeq: 4 }
  );
  await closeServer(server);
  const [body] = bodies;
  expect(body).toContain("mark_read");
  expect(body).toContain('"seq":4');
});

test("markDelivered does nothing when the wake has no seq", async () => {
  let calls = 0;
  await markDelivered(
    { bearerToken: "token", mcpUrl: "http://127.0.0.1:9/mcp" },
    { roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaa" },
    () => {
      calls += 1;
      return Promise.resolve(new Response());
    }
  );
  expect(calls).toBe(0);
});

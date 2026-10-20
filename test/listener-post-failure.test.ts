import { expect, test } from "bun:test";
import { postFailure } from "../listeners/listener-io.mjs";

const roomId = "room_0123456789abcdef01234567";

test("postFailure asks the room to mention @human for the missed range", async () => {
  let sent:
    | {
        name?: string;
        arguments?: { room?: string; body?: string; mentions?: string[] };
      }
    | undefined;
  const ok = await postFailure(
    { bearerToken: "tok", mcpUrl: "http://127.0.0.1/mcp" },
    { fromSeq: 4, roomId, toSeq: 9 },
    (_url, init) => {
      sent = JSON.parse(init.body).params;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve("{}"),
      });
    }
  );
  expect(ok).toBe(true);
  expect(sent?.name).toBe("post_message");
  expect(sent?.arguments?.room).toBe(roomId);
  expect(sent?.arguments?.mentions).toEqual(["human"]);
  expect(sent?.arguments?.body).toBe(
    "@human I failed to process messages 4 through 9 after 3 attempts."
  );
  const rejected = await postFailure(
    { bearerToken: "tok", mcpUrl: "http://127.0.0.1/mcp" },
    { fromSeq: 4, roomId, toSeq: 9 },
    () =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('{"isError":true}'),
      })
  );
  expect(rejected).toBe(false);
});

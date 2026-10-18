import { Worker } from "alchemy/Cloudflare";
import { Config, Effect, Layer } from "effect";
import { dispatch } from "./api/dispatch.ts";
import { chatLayer } from "./app/chat.ts";
import DirectoryServer from "./directory/directory-server.ts";
import RoomServer from "./room/room-server.ts";

export const adminTokenKey = "AGENT_ROOMS_ADMIN_TOKEN";
export const adminNameKey = "AGENT_ROOMS_ADMIN_NAME";
export const defaultAdminName = "human";

export const buildApi = Effect.gen(function* () {
  yield* RoomServer;
  yield* DirectoryServer;
  yield* Config.Redacted(adminTokenKey);
  yield* Config.String(adminNameKey).pipe(Config.withDefault(defaultAdminName));
  // Fetch does not carry the Worker service. Build the clients here, while it does, and close over them.
  const chatServices = yield* Effect.scoped(Layer.build(chatLayer));
  return {
    fetch: dispatch.pipe(Effect.provide(Layer.succeedContext(chatServices))),
  };
});

export const apiWorkerName = "Api";

export const apiOptions = {
  compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
  main: import.meta.url,
};

export default class Api extends Worker<Api>()(
  apiWorkerName,
  apiOptions,
  buildApi
) {}

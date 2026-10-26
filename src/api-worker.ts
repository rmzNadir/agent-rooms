import { Worker } from "alchemy/Cloudflare";
import { Config, Effect, Layer } from "effect";
import { dispatch } from "./api/dispatch.ts";
import { chatLayer } from "./app/chat.ts";
import { readEnv } from "./boundary/external.ts";
import { roomsOnCloudflare } from "./runtime/domain-host.ts";
import {
  type DoorNamespace,
  doorCredentials,
  doorLegacy,
  doorSockets,
} from "./runtime/legacy-client.ts";
import { DirectoryServer, RoomServer } from "./runtime/legacy-door.ts";
import { deployInput, deploySurface } from "./runtime/worker-surface.ts";

export const adminTokenKey = "AGENT_ROOMS_ADMIN_TOKEN";
export const adminNameKey = "AGENT_ROOMS_ADMIN_NAME";
export const defaultAdminName = "human";

export const buildApi = Effect.gen(function* () {
  yield* Config.Redacted(adminTokenKey);
  yield* Config.String(adminNameKey).pipe(Config.withDefault(defaultAdminName));
  const chatServices = yield* Layer.build(chatLayer);
  return {
    fetch: dispatch.pipe(Effect.provide(Layer.succeedContext(chatServices))),
  };
});

export const apiWorkerName = "Api";

export const apiOptions = {
  compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
  main: import.meta.url,
  ...deploySurface(deployInput(readEnv)),
};

const asDoor = (value: object) => value as DoorNamespace;

export const bootWith = <Services, Host>(
  directory: Effect.Effect<object, never, Services>,
  room: Effect.Effect<object, never, Services>,
  hostedLayer: () => Host
) =>
  Effect.gen(function* () {
    const directoryNs = asDoor(yield* directory);
    const roomNs = asDoor(yield* room);
    const credentials = doorCredentials(directoryNs);
    const hosted = Layer.provide(
      hostedLayer() as Layer.Layer<never>,
      credentials
    );
    const legacy = doorLegacy(directoryNs, roomNs).pipe(
      Layer.provide(hosted),
      Layer.provide(credentials)
    );
    const sockets = doorSockets(roomNs);
    return yield* buildApi.pipe(
      Effect.provide(legacy),
      Effect.provide(hosted),
      Effect.provide(credentials),
      Effect.provide(sockets)
    );
  });

const boot = bootWith(DirectoryServer, RoomServer, roomsOnCloudflare);

export default class Api extends Worker<Api>()(
  apiWorkerName,
  apiOptions,
  boot
) {}

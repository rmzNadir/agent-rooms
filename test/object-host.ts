import { ConfigProvider, Effect, Layer, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { buildApi } from "../src/api-worker.ts";
import { readEnv, writeEnv } from "../src/boundary/external.ts";
import { legacySkip, memoryCredentials } from "../src/runtime/credentials.ts";
import { roomsInMemory } from "../src/runtime/domain-host.ts";
import { socketsSkip } from "../src/runtime/sockets.ts";

const fulfill = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>);

export const memoryHost = () =>
  Layer.mergeAll(
    legacySkip,
    memoryCredentials(),
    socketsSkip,
    roomsInMemory().pipe(Layer.provide(memoryCredentials()))
  );

const keep = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const scope = await Effect.runPromise(Scope.make());
  return fulfill(effect.pipe(Effect.provideService(Scope.Scope, scope)));
};

export const startHost = async () => {
  writeEnv("ALCHEMY_PHASE", "runtime");
  const context = await keep(Layer.build(memoryHost()));
  return Layer.succeedContext(context);
};

export type RoomHost = Awaited<ReturnType<typeof startHost>>;

export const envRecord = () => {
  const record: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = readEnv(key);
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
};

export const prepareRuntime = async () => {
  writeEnv("ALCHEMY_PHASE", "runtime");
  writeEnv("AGENT_ROOMS_ADMIN_TOKEN", "admin-token");
  writeEnv("AGENT_ROOMS_ADMIN_NAME", "human");
  const provider = ConfigProvider.fromEnv({ env: envRecord() });
  const scope = await Effect.runPromise(Scope.make());
  return { provider, scope };
};

export const startApi = async () => {
  const { provider, scope } = await prepareRuntime();
  const context = await fulfill(
    Layer.build(memoryHost()).pipe(Effect.provideService(Scope.Scope, scope))
  );
  const host = Layer.succeedContext(context);
  const shape = await fulfill(
    buildApi.pipe(
      Effect.provide(host),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provideService(Scope.Scope, scope)
    )
  );
  return {
    fetch: async (input: Request) => {
      const response = await fulfill(
        Effect.scoped(
          shape.fetch.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(input)
            ),
            Effect.provideService(ConfigProvider.ConfigProvider, provider),
            Effect.provide(host)
          )
        )
      );
      return HttpServerResponse.toWeb(response);
    },
    host,
  };
};

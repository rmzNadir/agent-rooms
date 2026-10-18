import { WorkerEnvironment } from "alchemy/Cloudflare";
import { asOutput } from "alchemy/Output";
import { Self } from "alchemy/Self";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { buildApi } from "../src/api-worker.ts";
import { readEnv, writeEnv } from "../src/boundary/external.ts";
import { buildDirectory } from "../src/directory/directory-server.ts";
import { buildRoom } from "../src/room/room-server.ts";
import { callbackRuntime, memoryLayer } from "./sqlite-state.ts";

const fulfill = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>);

const boot = <E, R, FetchError, FetchEnv>(
  setup: Effect.Effect<
    Effect.Effect<
      {
        readonly fetch: Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          FetchError,
          FetchEnv
        >;
      },
      E,
      R
    >
  >,
  name: string
) => {
  const sql = memoryLayer(name);
  const runtime = callbackRuntime(() => undefined);
  const ready = fulfill(
    Effect.gen(function* () {
      const inner = yield* setup;
      return yield* inner;
    }).pipe(Effect.provide(sql), Effect.provide(runtime))
  );
  return async (input: Request) => {
    const shape = await ready;
    const response = await fulfill(
      shape.fetch.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(input)
        ),
        Effect.provide(sql),
        Effect.provide(runtime)
      )
    );
    return HttpServerResponse.toWeb(response);
  };
};

const workerSelf = {
  bind: () => () => Effect.void,
  durableObjectNamespaces: asOutput({}),
  export: () => Effect.void,
  LogicalId: "Api",
  Type: "Cloudflare.Worker",
};

const hostLayer = (
  directory: (input: Request) => Promise<Response>,
  rooms: Map<string, (input: Request) => Promise<Response>>
) =>
  Layer.mergeAll(
    Layer.succeed(Self("Cloudflare.Worker"), workerSelf),
    Layer.succeed(WorkerEnvironment, {
      DirectoryServer: { getByName: () => ({ fetch: directory }) },
      RoomServer: {
        getByName: (name: string) => {
          const cached = rooms.get(name);
          if (cached !== undefined) {
            return { fetch: cached };
          }
          const fetch = boot(buildRoom, name);
          rooms.set(name, fetch);
          return { fetch };
        },
      },
    })
  );

export type RoomHost = ReturnType<typeof hostLayer>;

export const startHost = async (): Promise<RoomHost> => {
  writeEnv("ALCHEMY_PHASE", "runtime");
  const directory = await boot(buildDirectory, "directory");
  return hostLayer(directory, new Map());
};

const envRecord = () => {
  const record: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = readEnv(key);
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
};

export const startApi = async () => {
  writeEnv("ALCHEMY_PHASE", "runtime");
  writeEnv("AGENT_ROOMS_ADMIN_TOKEN", "admin-token");
  writeEnv("AGENT_ROOMS_ADMIN_NAME", "human");
  const provider = ConfigProvider.fromEnv({ env: envRecord() });
  const directory = await boot(buildDirectory, "directory");
  const host = hostLayer(directory, new Map());
  const shape = await fulfill(
    buildApi.pipe(
      Effect.provide(host),
      Effect.provideService(ConfigProvider.ConfigProvider, provider)
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

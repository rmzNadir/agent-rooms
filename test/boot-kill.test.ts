import { expect, test } from "bun:test";
import { Cause, ConfigProvider, Effect, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { bootWith } from "../src/api-worker.ts";
import { roomsInMemory } from "../src/runtime/domain-host.ts";
import { fulfill } from "./effect-run.ts";
import { prepareRuntime } from "./object-host.ts";

const stub = {
  getByName: () => ({
    fetch: () => Effect.die("The boot test reached a door."),
  }),
};

test("boot keeps the health check and the door cast", async () => {
  const { provider, scope } = await prepareRuntime();
  const shape = await fulfill(
    bootWith(Effect.succeed(stub), Effect.succeed(stub), roomsInMemory).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provideService(Scope.Scope, scope)
    )
  );
  const health = await fulfill(
    Effect.scoped(
      shape.fetch.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://rooms.internal/health")
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, provider)
      )
    )
  );
  const healthWeb = HttpServerResponse.toWeb(health);
  expect(healthWeb.status).toBe(200);
  expect(await healthWeb.json()).toEqual({ ok: true });
  const who = await fulfill(
    Effect.scoped(
      Effect.exit(
        shape.fetch.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://rooms.internal/api/whoami", {
                headers: { authorization: "Bearer admin-token" },
              })
            )
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, provider)
        )
      )
    )
  );
  expect(who._tag).toBe("Failure");
  if (who._tag === "Failure") {
    expect(Cause.pretty(who.cause)).toContain("The boot test reached a door.");
  }
});

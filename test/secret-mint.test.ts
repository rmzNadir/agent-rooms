import { expect, test } from "bun:test";
import { Effect, Layer, Scope } from "effect";
import { Chat } from "../src/app/chat.ts";
import { CredentialBook, legacySkip } from "../src/runtime/credentials.ts";
import { roomsInMemory } from "../src/runtime/domain-host.ts";
import { socketsSkip } from "../src/runtime/sockets.ts";
import { fulfill } from "./effect-run.ts";
import { chatRunner, requestId, resolveAdmin } from "./live-chat.ts";

const blankBook = Layer.succeed(
  CredentialBook,
  CredentialBook.of({
    get: () => Effect.succeed(undefined),
    put: () => Effect.void,
  })
);

test("registering a webhook mints a secret when the book has none", async () => {
  const scope = await Effect.runPromise(Scope.make());
  const context = await fulfill(
    Layer.build(
      Layer.mergeAll(
        legacySkip,
        blankBook,
        socketsSkip,
        roomsInMemory().pipe(Layer.provide(blankBook))
      )
    ).pipe(Effect.provideService(Scope.Scope, scope))
  );
  const { run } = chatRunner(Layer.succeedContext(context));
  const admin = await resolveAdmin(run);
  const hooked = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.registerWebhook(
        admin,
        requestId,
        "https://listener.example/hook"
      );
    })
  );
  expect(hooked.webhookUrl).toBe("https://listener.example/hook");
  expect(hooked.roomIds).toEqual([]);
});

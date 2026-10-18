import { Effect } from "effect";
import { signPayload } from "../domain/token.ts";
import { webhookUrlProblem } from "../domain/webhook-url.ts";
import { Webhook } from "../model/wake.ts";
import { CredentialBook } from "./credentials.ts";

const posted = (status: number) => status >= 200 && status < 300;

const transport = "transport";

export const WebhookLive = Webhook.toLayer(
  Effect.gen(function* () {
    const book = yield* CredentialBook;
    return {
      deliver: (args: {
        readonly agentId: string;
        readonly body: string;
        readonly roomId: string;
      }) =>
        Effect.gen(function* () {
          const credential = yield* book.get(args.agentId);
          if (credential === undefined) {
            return { status: 204 };
          }
          const { secret, url } = credential;
          if (url === null) {
            return { status: 204 };
          }
          if (secret.length === 0 || webhookUrlProblem(url) !== undefined) {
            return { status: 204 };
          }
          const timestamp = String(Date.now());
          const signature = yield* signPayload(secret, timestamp, args.body);
          const status = yield* Effect.tryPromise({
            catch: () => transport,
            try: () =>
              fetch(url, {
                body: args.body,
                headers: {
                  "content-type": "application/json",
                  "x-agent-rooms-signature": `sha256=${signature}`,
                  "x-agent-rooms-timestamp": timestamp,
                },
                method: "POST",
                redirect: "manual",
              }),
          }).pipe(
            Effect.map((value) => value.status),
            Effect.catch((reason) =>
              Effect.fail(new Error(`webhook 599 ${reason}`))
            )
          );
          if (!posted(status)) {
            return yield* Effect.fail(new Error(`webhook ${status}`));
          }
          return { status };
        }),
    };
  })
);

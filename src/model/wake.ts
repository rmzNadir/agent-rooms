import { ExternalSystem, Policy } from "alchemy/Domain";
import { Effect, Schedule, Schema } from "effect";
import { MAX_WAIT_MS, MAX_WAKE_ATTEMPTS } from "../domain/wake-policy.ts";
import { client } from "./client.ts";
import { Room } from "./room.ts";
import { ExpireWake, RecordDelivery } from "./room-commands.ts";
import { MessagePosted } from "./room-shape.ts";

export const Webhook = ExternalSystem("Webhook", {
  deliver: {
    args: { body: Schema.String, roomId: Schema.String },
    success: { status: Schema.Number },
  },
});

export class WakeDelivery extends Policy("WakeDelivery", {
  from: Room,
  on: [MessagePosted],
}) {}

export const wakeRetry = () => Schedule.recurs(MAX_WAKE_ATTEMPTS - 1);

export const wakeDeadline = () => MAX_WAIT_MS;

export const wakeDeliveryOptions = { retry: wakeRetry() };

export const WakeDeliveryLive = WakeDelivery.toLayer(
  Effect.gen(function* () {
    const rooms = yield* client<{
      readonly schedule: (
        id: string,
        command: object,
        options: { readonly after: number }
      ) => Effect.Effect<void>;
      readonly send: (id: string, command: object) => Effect.Effect<void>;
    }>(Room);
    const webhook = yield* client<{
      readonly deliver: (args: {
        readonly body: string;
        readonly roomId: string;
      }) => Effect.Effect<void>;
    }>(Webhook);
    return (trigger: {
      readonly event: {
        readonly message: { readonly body: string; readonly seq: number };
        readonly targets: readonly string[];
      };
      readonly source: { readonly id: string };
    }) => {
      if (trigger.event.targets.length === 0) {
        return Effect.void;
      }
      const id = String(trigger.event.message.seq);
      return Effect.gen(function* () {
        yield* webhook.deliver({
          body: trigger.event.message.body,
          roomId: trigger.source.id,
        });
        yield* rooms.send(trigger.source.id, new RecordDelivery({ id }));
        yield* rooms.schedule(trigger.source.id, new ExpireWake({ id }), {
          after: wakeDeadline(),
        });
      });
    };
  }),
  wakeDeliveryOptions
);

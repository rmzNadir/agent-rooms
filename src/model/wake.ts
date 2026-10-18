import { ExternalSystem, Policy } from "alchemy/Domain";
import { Effect, Schedule, Schema } from "effect";
import { deliveryIdFor, earlierSeq, wakePayload } from "../domain/wake-body.ts";
import { MAX_WAIT_MS, MAX_WAKE_ATTEMPTS } from "../domain/wake-policy.ts";
import { client } from "./client.ts";
import { Room } from "./room.ts";
import { ExpireWake, RecordDelivery } from "./room-commands.ts";
import { MessagePosted } from "./room-shape.ts";

export const Webhook = ExternalSystem("Webhook", {
  deliver: {
    args: {
      agentId: Schema.String,
      body: Schema.String,
      roomId: Schema.String,
    },
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
      readonly state: (id: string) => Effect.Effect<{
        readonly hopCount: number;
        readonly leadId: string | null;
        readonly messages: readonly { readonly seq: number }[];
        readonly name: string;
        readonly paused: boolean;
      }>;
    }>(Room);
    const webhook = yield* client<{
      readonly deliver: (args: {
        readonly agentId: string;
        readonly body: string;
        readonly roomId: string;
      }) => Effect.Effect<void>;
    }>(Webhook);
    return (trigger: {
      readonly event: {
        readonly message: { readonly seq: number };
        readonly targets: readonly string[];
      };
      readonly source: { readonly id: string };
    }) =>
      Effect.gen(function* () {
        const state = yield* rooms.state(trigger.source.id);
        const fromSeq = earlierSeq(
          state.messages.map((message) => message.seq),
          trigger.event.message.seq
        );
        for (const agentId of trigger.event.targets) {
          const id = deliveryIdFor(trigger.event.message.seq, agentId);
          yield* webhook.deliver({
            agentId,
            body: wakePayload({
              agentId,
              deliveryId: id,
              fromSeq,
              hopCount: state.hopCount,
              paused: state.paused,
              roomId: trigger.source.id,
              roomName: state.name,
              toSeq: trigger.event.message.seq,
              youAreLead: state.leadId === agentId,
            }),
            roomId: trigger.source.id,
          });
          yield* rooms.send(trigger.source.id, new RecordDelivery({ id }));
          yield* rooms.schedule(trigger.source.id, new ExpireWake({ id }), {
            after: wakeDeadline(),
          });
        }
      });
  }),
  wakeDeliveryOptions
);

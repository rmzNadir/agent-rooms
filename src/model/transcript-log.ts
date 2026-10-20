import { Event, Projection, Stream } from "alchemy/Domain";
import { Effect, Schema } from "effect";
import { client } from "./client.ts";
import { Room } from "./room.ts";
import { MessagePosted, PauseNoticePosted } from "./room-shape.ts";

export class TranscriptLine extends Event("TranscriptLine", {
  body: Schema.String,
  seq: Schema.Number,
}) {}

export const TranscriptLog = Stream("TranscriptLog", {
  entries: [TranscriptLine],
  key: Room,
});

export class TranscriptLines extends Projection("TranscriptLines", {
  from: [Room],
  key: Room,
  on: [MessagePosted, PauseNoticePosted],
  writes: [TranscriptLog],
}) {}

export const TranscriptLinesLive = TranscriptLines.toLayer(
  Effect.gen(function* () {
    const log = yield* client<{
      readonly append: (origin: object, event: object) => Effect.Effect<void>;
    }>(TranscriptLog);
    return (
      batch: readonly {
        readonly event: {
          readonly _tag: string;
          readonly message: { readonly body: string; readonly seq: number };
        };
      }[]
    ) =>
      Effect.gen(function* () {
        for (const input of batch) {
          yield* log.append(
            input,
            new TranscriptLine({
              body: input.event.message.body,
              seq: input.event.message.seq,
            })
          );
        }
      });
  })
);

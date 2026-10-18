import { Model } from "alchemy/Domain";
import { Layer } from "effect";
import { Directory } from "./directory.ts";
import { Room } from "./room.ts";
import {
  TranscriptLines,
  TranscriptLinesLive,
  TranscriptLog,
} from "./transcript-log.ts";
import { SearchIndex, Transcript, Unread } from "./views.ts";
import { WakeDelivery, WakeDeliveryLive } from "./wake.ts";

export class Rooms extends Model("Rooms", {
  aggregates: [Room, Directory],
  policies: [WakeDelivery],
  projections: [TranscriptLines],
  streams: [TranscriptLog],
  views: [Transcript, Unread, SearchIndex],
}) {}

export const RoomsHandlers = Layer.mergeAll(
  WakeDeliveryLive,
  TranscriptLinesLive
);

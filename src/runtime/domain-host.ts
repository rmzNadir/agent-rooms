import { InMemory } from "alchemy/Domain";
import { DurableObjects } from "alchemy/Domain/Cloudflare";
import { Layer } from "effect";
import { Rooms, RoomsHandlers } from "../model/rooms-model.ts";
import { WebhookLive } from "./webhook-live.ts";

const handlers = RoomsHandlers.pipe(Layer.provide(WebhookLive));

export const roomsOnCloudflare = () =>
  Rooms.layer(handlers).pipe(Layer.provide(DurableObjects));

export const roomsInMemory = () =>
  Rooms.layer(handlers).pipe(Layer.provide(InMemory));

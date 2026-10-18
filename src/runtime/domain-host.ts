import { DurableObjects } from "alchemy/Domain/Cloudflare";
import { Layer } from "effect";
import { Rooms, RoomsHandlers } from "../model/rooms-model.ts";

export const roomsOnCloudflare = () =>
  Rooms.layer(RoomsHandlers).pipe(Layer.provide(DurableObjects));

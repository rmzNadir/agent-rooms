import { Effect, Schema } from "effect";
import { LegacyDirectorySchema, LegacyRoomSchema } from "../model/migrate.ts";
import {
  applyDirectory,
  applyRoom,
  type DirectoryHandle,
  type RoomHandle,
  type SecretBook,
} from "./legacy-apply.ts";

const DirectoryBody = Schema.Struct({
  migrated: Schema.Boolean,
  snapshot: Schema.NullOr(LegacyDirectorySchema),
});

const RoomBody = Schema.Struct({
  migrated: Schema.Boolean,
  snapshot: Schema.NullOr(LegacyRoomSchema),
});

export const decodeDirectoryBody = Schema.decodeUnknownEffect(DirectoryBody);
export const decodeRoomBody = Schema.decodeUnknownEffect(RoomBody);

export const importDirectorySnapshot = (
  body: Schema.Schema.Type<typeof DirectoryBody>,
  mark: Effect.Effect<void>,
  book: SecretBook,
  directory: DirectoryHandle
) =>
  Effect.gen(function* () {
    if (body.migrated) {
      return;
    }
    if (body.snapshot !== null) {
      yield* applyDirectory(body.snapshot, book, directory);
    }
    yield* mark;
  });

export const importRoomSnapshot = (
  body: Schema.Schema.Type<typeof RoomBody>,
  mark: Effect.Effect<void>,
  book: SecretBook,
  rooms: RoomHandle
) =>
  Effect.gen(function* () {
    if (body.migrated || body.snapshot === null) {
      if (!body.migrated) {
        yield* mark;
      }
      return;
    }
    yield* applyRoom(body.snapshot, book, rooms);
    yield* mark;
  });

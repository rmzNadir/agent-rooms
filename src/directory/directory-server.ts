import { DurableObject } from "alchemy/Cloudflare";
import { Platform } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  createAgent,
  getAgent,
  listAgents,
  resolve,
  rotateToken,
  setWebhook,
} from "./directory-agents.ts";
import { DirectoryHttpApi } from "./directory-http-api.ts";
import {
  deleteMembership,
  deleteRoom,
  listRooms,
  putMembership,
  putRoom,
} from "./directory-rooms.ts";
import { migrateDirectory } from "./directory-sql.ts";

export default class DirectoryServer extends DurableObject<DirectoryServer>()(
  "DirectoryServer",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      yield* migrateDirectory;

      const handlers = HttpApiBuilder.group(
        DirectoryHttpApi,
        "directory",
        (group) =>
          group
            .handle("resolve", ({ payload }) => resolve(payload))
            .handle("createAgent", ({ payload }) => createAgent(payload))
            .handle("listAgents", ({ payload }) => listAgents(payload))
            .handle("rotateToken", ({ payload }) => rotateToken(payload))
            .handle("setWebhook", ({ payload }) => setWebhook(payload))
            .handle("putRoom", ({ payload }) => putRoom(payload))
            .handle("deleteRoom", ({ payload }) => deleteRoom(payload))
            .handle("listRooms", ({ payload }) => listRooms(payload))
            .handle("putMembership", ({ payload }) => putMembership(payload))
            .handle("deleteMembership", ({ payload }) =>
              deleteMembership(payload)
            )
            .handle("getAgent", ({ payload }) => getAgent(payload))
      );

      return {
        fetch: Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* HttpRouter.toHttpEffect(
              HttpApiBuilder.layer(DirectoryHttpApi).pipe(
                Layer.provide(handlers),
                Layer.provide(Platform)
              )
            );
            return yield* handle;
          })
        ),
      };
    });
  })
) {}

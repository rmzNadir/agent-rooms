import { Cause, Effect } from "effect";
import { Chat, chatLayer } from "../src/app/chat.ts";
import { Actor } from "../src/domain/actor.ts";
import {
  type AgentId,
  internalRequestId,
  type RoomId,
} from "../src/domain/ids.ts";
import { hashToken } from "../src/domain/token.ts";
import type { RoomHost } from "./object-host.ts";

export const requestId = internalRequestId;
const chatService = () => Chat;

// Yielding a durable object still types its requirement as the Worker service after that service is provided.
export const fulfill = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>);

export const chatRunner = (host: RoomHost) => {
  const run = <A, E>(effect: Effect.Effect<A, E, Chat>) =>
    fulfill(
      Effect.scoped(Effect.orDie(effect)).pipe(
        Effect.provide(chatLayer),
        Effect.provide(host)
      )
    );
  const failure = <A, E>(effect: Effect.Effect<A, E, Chat>) =>
    fulfill(
      Effect.scoped(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(effect);
          if (exit._tag === "Success") {
            return yield* Effect.die("This call was expected to fail.");
          }
          return Cause.squash(exit.cause);
        })
      ).pipe(Effect.provide(chatLayer), Effect.provide(host))
    );
  return { failure, run };
};

export const actorFor = (
  agentId: Actor["agentId"],
  displayName: string,
  admin: boolean,
  kind: "agent" | "human"
) => new Actor({ admin, agentId, displayName, kind });

export type ChatRun = ReturnType<typeof chatRunner>["run"];

export const adminAuth = { authorization: "Bearer admin-token" };

export const httpClient = (fetchApi: (input: Request) => Promise<Response>) => {
  const send = (path: string, init?: RequestInit) =>
    fetchApi(new Request(`http://localhost${path}`, init));
  const jsonBody = (body: object) => JSON.stringify(body);
  return { jsonBody, send };
};

export const postAgent = (
  send: (path: string, init?: RequestInit) => Promise<Response>,
  jsonBody: (body: object) => string,
  headers: { readonly authorization: string },
  displayName: string,
  kind: "agent" | "human"
) =>
  send("/admin/agents", {
    body: jsonBody({ displayName, kind }),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST",
  });

export const resolveAdmin = async (run: ChatRun) => {
  const adminHash = await Effect.runPromise(hashToken("admin-token"));
  const adminView = await run(
    Effect.gen(function* () {
      const chat = yield* chatService();
      return yield* chat.resolve(adminHash, adminHash, "human");
    })
  );
  return actorFor(adminView.agentId, "human", true, "human");
};

export const createPerson = async (
  run: ChatRun,
  actor: Actor,
  name: string,
  kind: "agent" | "human"
) => {
  const created = await run(
    Effect.gen(function* () {
      const chat = yield* chatService();
      return yield* chat.createAgent(actor, requestId, name, kind, null);
    })
  );
  return {
    actor: actorFor(created.agent.agentId, name, false, kind),
    created,
  };
};

export const invitePerson = (
  run: ChatRun,
  actor: Actor,
  roomId: RoomId,
  agentId: AgentId
) =>
  run(
    Effect.gen(function* () {
      const chat = yield* chatService();
      return yield* chat.invite(actor, requestId, roomId, agentId);
    })
  );

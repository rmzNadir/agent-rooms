import { localState } from "alchemy";
import { providers } from "alchemy/Cloudflare";
import { make } from "alchemy/Test/Bun";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Json } from "effect/Schema";
import type { WakeCall } from "../../listeners/listener-io.mjs";
import {
  at,
  fillEnv,
  isJsonObject,
  parseJson,
  setAt,
  writeEnv,
} from "../../src/boundary/external.ts";

export const defined = <Value>(value: Value | undefined, detail: string) =>
  Effect.gen(function* () {
    if (value === undefined) {
      return yield* Effect.die(detail);
    }
    return value;
  });

export const dieUnless = (ok: boolean, detail: string) =>
  Effect.gen(function* () {
    if (!ok) {
      return yield* Effect.die(detail);
    }
  });

export const wakeSeq = (value: number | undefined): number => {
  if (value === undefined) {
    throw new Error("wake seq missing");
  }
  return value;
};

writeEnv("AGENT_ROOMS_LOCAL_STATE", "1");
fillEnv("AGENT_ROOMS_ADMIN_TOKEN", "integration-admin-token");
fillEnv("AGENT_ROOMS_ADMIN_NAME", "human");

const { default: Stack } = await import("../../alchemy.run.ts");

export const { test, beforeAll, deploy } = make({
  dev: true,
  providers: providers(),
  sidecar: false,
  stage: "dev-agent-rooms",
  state: localState(),
});

export const ready = beforeAll(deploy(Stack));
export const suffix = Math.random().toString(16).slice(2, 8);

export const Health = Schema.Struct({ ok: Schema.Literal(true) });
export const Created = Schema.Struct({
  agent: Schema.Struct({ agentId: Schema.String, displayName: Schema.String }),
  token: Schema.String,
});
export const Rpc = Schema.Struct({
  error: Schema.optional(Schema.Json),
  jsonrpc: Schema.Literal("2.0"),
  result: Schema.optional(Schema.Json),
});

export const roomIdPattern = /room_[0-9a-f]{24}/;
export const unreadAdvanced = /lastReadSeq\\":[1-9]/;
export const unreadZero = /lastReadSeq\\":0/;
export const httpPrefix = /^http/;

export const roomIdIn = (text: string): string | undefined => {
  const [roomId] = roomIdPattern.exec(text) ?? [];
  return roomId;
};

const wakeText = (value: Json | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const wakeNumber = (value: Json | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const assignWake = (
  call: {
    agentId?: string;
    deliveryId?: string;
    fromSeq?: number;
    roomId?: string;
    sinceCursor?: number;
    toSeq?: number;
  },
  key: "agentId" | "deliveryId" | "roomId",
  value: string | undefined
) => {
  if (value !== undefined) {
    call[key] = value;
  }
};

const assignSeq = (
  call: { fromSeq?: number; sinceCursor?: number; toSeq?: number },
  key: "fromSeq" | "sinceCursor" | "toSeq",
  value: number | undefined
) => {
  if (value !== undefined) {
    call[key] = value;
  }
};

export const observedWake = (text: string): WakeCall => {
  const parsed = parseJson(text);
  const call: {
    agentId?: string;
    deliveryId?: string;
    fromSeq?: number;
    roomId?: string;
    sinceCursor?: number;
    toSeq?: number;
  } = {};
  if (!isJsonObject(parsed)) {
    return call;
  }
  assignWake(call, "agentId", wakeText(at(parsed, "agentId")));
  assignWake(call, "deliveryId", wakeText(at(parsed, "deliveryId")));
  assignWake(call, "roomId", wakeText(at(parsed, "roomId")));
  assignSeq(call, "fromSeq", wakeNumber(at(parsed, "fromSeq")));
  assignSeq(call, "sinceCursor", wakeNumber(at(parsed, "sinceCursor")));
  assignSeq(call, "toSeq", wakeNumber(at(parsed, "toSeq")));
  return call;
};

export const workerUrl = Effect.gen(function* () {
  const compiled = yield* ready;
  const { url } = compiled;
  if (url === undefined) {
    return yield* Effect.die("The local worker did not publish a url.");
  }
  return url;
});

export const createToolRoom = (
  url: string,
  token: string,
  name: string,
  topic: string,
  members: readonly string[]
) =>
  Effect.gen(function* () {
    const room = yield* post(
      `${url}/mcp`,
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { members, name, topic },
          name: "create_room",
        },
      },
      token
    );
    if (room.status !== 200) {
      return yield* Effect.die(room.text);
    }
    const roomId = roomIdIn(room.text);
    if (roomId === undefined) {
      return yield* Effect.die(room.text);
    }
    return roomId;
  });

export const post = (url: string, body: Json, token?: string) =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== undefined) {
      setAt(headers, "authorization", `Bearer ${token}`);
    }
    const request = HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(url, { headers }),
      body
    );
    const response = yield* HttpClient.execute(request);
    const text = yield* response.text;
    return { status: response.status, text };
  });

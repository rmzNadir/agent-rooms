import { expect, test } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { signPayload } from "../src/domain/token.ts";
import { client } from "../src/model/client.ts";
import { Webhook } from "../src/model/wake.ts";
import {
  CredentialBook,
  memoryCredentials,
} from "../src/runtime/credentials.ts";
import { WebhookLive } from "../src/runtime/webhook-live.ts";

const agentId = "agent_bbbbbbbbbbbbbbbbbbbbbbbb";
const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";
const body =
  '{"deliveryId":"dlv_test","roomId":"room_aaaaaaaaaaaaaaaaaaaaaaaa"}';
const secret = "whsec-live";

const saved = (url: string | null, webhookSecret = secret) => ({
  admin: false,
  secret: webhookSecret,
  url,
});

type FetchCall = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const fulfill = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>);

const outcome = async (
  fetchImpl: FetchCall,
  credential?: {
    readonly admin: boolean;
    readonly secret: string;
    readonly url: string | null;
  }
) => {
  const book = memoryCredentials();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl as never;
  const program = Effect.gen(function* () {
    if (credential !== undefined) {
      const store = yield* CredentialBook;
      yield* store.put(agentId, credential);
    }
    const hook = yield* client<{
      readonly deliver: (args: {
        readonly agentId: string;
        readonly body: string;
        readonly roomId: string;
      }) => Effect.Effect<{ readonly status: number }, Error>;
    }>(Webhook);
    return yield* hook.deliver({ agentId, body, roomId });
  }).pipe(
    Effect.provide(WebhookLive.pipe(Layer.provide(book))),
    Effect.provide(book)
  );
  try {
    return await fulfill(Effect.exit(program));
  } finally {
    globalThis.fetch = previous;
  }
};

const statusFetch = (status: number) => {
  const calls: Array<{
    readonly init: RequestInit | undefined;
    readonly url: string;
  }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({ init, url: String(url) });
    return await Promise.resolve(new Response("ok", { status }));
  }) satisfies FetchCall;
  return { calls, fetchImpl };
};

test("a missing webhook credential is ignored", async () => {
  const exit = await outcome(() => {
    throw new Error("webhook fetch should not run");
  });
  expect(exit._tag).toBe("Success");
  if (exit._tag === "Success") {
    expect(exit.value).toEqual({ status: 204 });
  }
});

test("an empty secret, a null url, and a private url are ignored", async () => {
  const blocked = () => {
    throw new Error("webhook fetch should not run");
  };
  const emptySecret = await outcome(
    blocked,
    saved("https://example.com/hook", "")
  );
  const nullUrl = await outcome(blocked, saved(null));
  const privateUrl = await outcome(blocked, saved("https://10.1.2.3/hook"));
  expect(emptySecret._tag).toBe("Success");
  expect(nullUrl._tag).toBe("Success");
  expect(privateUrl._tag).toBe("Success");
  if (
    emptySecret._tag === "Success" &&
    nullUrl._tag === "Success" &&
    privateUrl._tag === "Success"
  ) {
    expect(emptySecret.value).toEqual({ status: 204 });
    expect(nullUrl.value).toEqual({ status: 204 });
    expect(privateUrl.value).toEqual({ status: 204 });
  }
});

test("a 2xx webhook is signed", async () => {
  const ok = statusFetch(200);
  const edge = statusFetch(299);
  const signed = await outcome(ok.fetchImpl, saved("https://example.com/hook"));
  const stillOk = await outcome(
    edge.fetchImpl,
    saved("https://example.com/hook")
  );
  expect(signed._tag).toBe("Success");
  expect(stillOk._tag).toBe("Success");
  if (signed._tag === "Success" && stillOk._tag === "Success") {
    expect(signed.value).toEqual({ status: 200 });
    expect(stillOk.value).toEqual({ status: 299 });
  }
  const [call] = ok.calls;
  const headers = new Headers(call?.init?.headers);
  const timestamp = headers.get("x-agent-rooms-timestamp") ?? "";
  const signature = await fulfill(signPayload(secret, timestamp, body));
  expect(call?.url).toBe("https://example.com/hook");
  expect(call?.init?.method).toBe("POST");
  expect(call?.init?.redirect).toBe("manual");
  expect(call?.init?.body).toBe(body);
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("x-agent-rooms-signature")).toBe(`sha256=${signature}`);
  expect(Math.abs(Date.now() - Number(timestamp))).toBeLessThan(10_000);
});

test("a non-2xx webhook fails", async () => {
  const redirected = await outcome(
    statusFetch(300).fetchImpl,
    saved("https://example.com/hook")
  );
  const crashed = await outcome(
    statusFetch(500).fetchImpl,
    saved("https://example.com/hook")
  );
  expect(redirected._tag).toBe("Failure");
  expect(crashed._tag).toBe("Failure");
  if (redirected._tag === "Failure" && crashed._tag === "Failure") {
    expect(Cause.pretty(redirected.cause)).toContain("webhook 300");
    expect(Cause.pretty(crashed.cause)).toContain("webhook 500");
  }
});

test("a status below 200 is not delivered", async () => {
  const exit = await outcome(
    async () => await Promise.resolve({ status: 199 } as Response),
    saved("https://example.com/hook")
  );
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    expect(Cause.pretty(exit.cause)).toContain("webhook 199");
  }
});

test("a transport failure becomes webhook 599", async () => {
  const exit = await outcome(
    async () => await Promise.reject(new Error("down")),
    saved("https://example.com/hook")
  );
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    expect(Cause.pretty(exit.cause)).toContain("webhook 599 transport");
  }
});

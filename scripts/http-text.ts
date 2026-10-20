import { readEnv } from "../src/boundary/external.ts";
import { field, readPayload, textField } from "./snapshot-diff.ts";

export interface TextReply {
  readonly status: number;
  readonly text: string;
}

export type FetchLike = (
  url: string,
  init: {
    readonly body?: FormData | string;
    readonly headers: { readonly [key: string]: string };
    readonly method: string;
    readonly signal?: AbortSignal;
  }
) => Promise<{
  readonly status: number;
  text: () => Promise<string>;
}>;

const trailingSlash = /\/$/u;

export const requireEnv = (key: string) => {
  const value = readEnv(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${key}`);
  }
  return value;
};

export const requestHeaders = (
  token: string,
  contentType: string | undefined
) => {
  const headers: {
    accept: string;
    authorization?: string;
    "content-type"?: string;
  } = {
    accept: "application/json",
  };
  if (token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  if (contentType !== undefined) {
    headers["content-type"] = contentType;
  }
  return headers;
};

export const READ_ATTEMPTS = 3;
export const READ_TIMEOUT_MS = 20_000;

export const backoffMs = (attempt: number) => attempt * 200;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const errorCode = (error: Error): string | undefined => {
  const { cause } = error;
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const { code } = cause as { readonly code?: string };
  return typeof code === "string" ? code : undefined;
};

export const transportFailure = (error: Error) => {
  const code = errorCode(error);
  if (code === "ECONNRESET" || code === "ETIMEDOUT") {
    return true;
  }
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }
  return (
    error.message.includes("ECONNRESET") ||
    error.message.includes("socket connection was closed")
  );
};

const mcpTool = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }
  return textField(field(readPayload(body), "params"), "name");
};

export const readOnly = (method: string, path: string, body?: string) => {
  if (method === "GET") {
    return (
      path === "/admin/agents" ||
      path === "/api/rooms" ||
      path === "/api/whoami"
    );
  }
  const name = mcpTool(body);
  return (
    method === "POST" &&
    path === "/mcp" &&
    (name === "members" || name === "read_transcript" || name === "whoami")
  );
};

const timed = (timeoutMs: number | undefined) =>
  timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) };

export const textRequestWith = async (
  fetchLike: FetchLike,
  method: string,
  url: string,
  token: string,
  body?: string,
  contentType?: string,
  timeoutMs?: number
): Promise<TextReply> => {
  const headers = requestHeaders(token, contentType);
  const init = { headers, method, ...timed(timeoutMs) };
  const response =
    body === undefined
      ? await fetchLike(url, init)
      : await fetchLike(url, { ...init, body });
  return { status: response.status, text: await response.text() };
};

export const textRequest = (
  method: string,
  url: string,
  token: string,
  body?: string,
  contentType?: string,
  timeoutMs?: number
) => textRequestWith(fetch, method, url, token, body, contentType, timeoutMs);

const again = (
  run: () => Promise<TextReply>,
  sleep: (ms: number) => Promise<void>,
  attempt: number
) => sleep(backoffMs(attempt)).then(() => runRead(run, sleep, attempt + 1));

const settle = (
  run: () => Promise<TextReply>,
  sleep: (ms: number) => Promise<void>,
  attempt: number,
  reply: TextReply | undefined,
  error: Error | undefined
): Promise<TextReply> => {
  if (reply !== undefined) {
    if (reply.status < 500 || attempt >= READ_ATTEMPTS) {
      return Promise.resolve(reply);
    }
    return again(run, sleep, attempt);
  }
  if (
    error === undefined ||
    !transportFailure(error) ||
    attempt >= READ_ATTEMPTS
  ) {
    return Promise.reject(error ?? new Error("request failed"));
  }
  return again(run, sleep, attempt);
};

const thrown = (value: object | string | undefined) =>
  value instanceof Error ? value : new Error("request failed");

const runRead = (
  run: () => Promise<TextReply>,
  sleep: (ms: number) => Promise<void>,
  attempt: number
) =>
  run().then(
    (reply) => settle(run, sleep, attempt, reply, undefined),
    (value: object | string | undefined) =>
      settle(run, sleep, attempt, undefined, thrown(value))
  );

export const retryRead = (
  run: () => Promise<TextReply>,
  sleep: (ms: number) => Promise<void> = delay
) => runRead(run, sleep, 1);

export type AppCall = (
  method: string,
  path: string,
  token: string,
  body?: string
) => Promise<TextReply>;

export const appFetchWith = (base: string, fetchLike: FetchLike): AppCall => {
  const root = base.replace(trailingSlash, "");
  return (method, path, token, body) =>
    textRequestWith(
      fetchLike,
      method,
      `${root}${path}`,
      token,
      body,
      "application/json",
      readOnly(method, path, body) ? READ_TIMEOUT_MS : undefined
    );
};

export const appFetch = (base: string) => appFetchWith(base, fetch);

export type CfCall = (
  method: string,
  path: string,
  body?: string,
  contentType?: string
) => Promise<TextReply>;

const cfRoot = "https://api.cloudflare.com/client/v4";

export const cfFetch =
  (token: string): CfCall =>
  (method, path, body, type) =>
    textRequest(method, `${cfRoot}${path}`, token, body, type);

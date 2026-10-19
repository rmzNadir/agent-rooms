import { readEnv } from "../src/boundary/external.ts";

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

export const textRequestWith = async (
  fetchLike: FetchLike,
  method: string,
  url: string,
  token: string,
  body?: string,
  contentType?: string
): Promise<TextReply> => {
  const headers = requestHeaders(token, contentType);
  const response =
    body === undefined
      ? await fetchLike(url, { headers, method })
      : await fetchLike(url, { body, headers, method });
  return { status: response.status, text: await response.text() };
};

export const textRequest = (
  method: string,
  url: string,
  token: string,
  body?: string,
  contentType?: string
) => textRequestWith(fetch, method, url, token, body, contentType);

export type AppCall = (
  method: string,
  path: string,
  token: string,
  body?: string
) => Promise<TextReply>;

export const appFetch = (base: string): AppCall => {
  const root = base.replace(trailingSlash, "");
  return (method, path, token, body) =>
    textRequest(method, `${root}${path}`, token, body, "application/json");
};

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

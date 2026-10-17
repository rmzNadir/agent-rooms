import type { HttpServerRequest } from "effect/http"

// `request.url` has the scheme and host stripped (HttpServerRequest.fromWeb). Only `originalUrl` keeps them.
export const isHttps = (request: HttpServerRequest.HttpServerRequest) => request.originalUrl.startsWith("https://")

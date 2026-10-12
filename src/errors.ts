import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  GateNotOpenedError,
  PermissionDeniedError,
  RateLimitError,
} from "@nimbio/community-api";

/**
 * One-line, log-safe description of an SDK error.
 *
 * Built from named fields only (status, code, request id) — never the response
 * body, which can carry member data, and never the API key. Users paste
 * Homebridge logs into public GitHub issues.
 */
export function describeError(e: unknown): string {
  const rid = e instanceof APIError && e.requestId ? ` (request ${e.requestId})` : "";
  if (e instanceof GateNotOpenedError) return `the gate did not confirm the open${rid}`;
  if (e instanceof AuthenticationError) return `the API key was rejected${rid}`;
  if (e instanceof PermissionDeniedError) return `not permitted: ${e.code ?? "forbidden"}${rid}`;
  if (e instanceof RateLimitError) {
    const wait = e.retryAfter ? `, retry after ${e.retryAfter}s` : "";
    return `rate limited: ${e.code ?? "too many requests"}${wait}${rid}`;
  }
  if (e instanceof APIError) return `HTTP ${e.status}${e.code ? ` ${e.code}` : ""}${rid}`;
  if (e instanceof APIConnectionError) return "could not reach Nimbio";
  if (e instanceof Error) return e.message;
  return String(e);
}

/** The live stream allows 3 concurrent connections per key. */
export function isStreamLimit(e: unknown): boolean {
  return e instanceof RateLimitError && e.code === "stream_limit";
}

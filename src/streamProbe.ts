import type { FetchLike } from "@nimbio/community-api";

/** The SDK's live-event endpoint. */
export const STREAM_PATH = "/v1/events/stream";

/**
 * Tells the live updater when the event stream has *really* connected.
 *
 * `community.streamEvents()` yields nothing until an event arrives and quietly
 * retries connection-level failures, so "no error yet" says nothing about
 * whether the stream is up — guessing from elapsed time got it wrong both ways.
 * The SDK takes a `fetch` option; this wraps it as a pure pass-through and
 * reports a 200 on the stream path, which is exactly "connected".
 *
 * Stopgap until the SDK exposes an on-connect signal of its own (follow-up);
 * it adds no HTTP behaviour — every request and response passes unchanged.
 */
export class StreamProbe {
  private listener: (() => void) | undefined;

  onOpen(fn: () => void): void {
    this.listener = fn;
  }

  wrap(inner: FetchLike = (input, init) => fetch(input, init)): FetchLike {
    return async (input, init) => {
      const res = await inner(input, init);
      if (res.status === 200 && input.split("?")[0]!.endsWith(STREAM_PATH)) this.listener?.();
      return res;
    };
  }
}

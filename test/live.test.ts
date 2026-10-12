import { AuthenticationError, RateLimitError } from "@nimbio/community-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveUpdater, STREAM_EVENTS } from "../src/live.js";
import { StateStore } from "../src/state.js";
import { flush, latch, makeLog, makeStream } from "./helpers.js";

function setup(opts: Partial<ConstructorParameters<typeof LiveUpdater>[3]> = {}) {
  const stream = makeStream();
  const client = {
    community: {
      gateStatus: vi.fn().mockResolvedValue({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed"])], raw: {} }),
      holdOpens: vi.fn().mockResolvedValue({ latches: {}, raw: {} }),
      streamEvents: stream.streamEvents,
    },
  };
  const store = new StateStore();
  const log = makeLog();
  const live = new LiveUpdater(client as never, store, log, {
    liveUpdates: "stream", pollSeconds: 60, gateStatus: true, holdOpens: true, streamRetryMs: 1000, ...opts,
  });
  return { live, client, store, log, stream };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

describe("LiveUpdater", () => {
  it("seeds, then applies stream events; device events re-seed; reset re-seeds", async () => {
    const { live, client, store, stream } = setup();
    await live.start();
    await flush();
    expect(store.get("L1")?.status).toBe("Closed");
    expect(stream.calls[0]?.events).toEqual(STREAM_EVENTS);

    stream.push({ kind: "event", id: "1", type: "sense_line.changed", data: { latch_id: "L1", status_label: "Open" }, payload: {} });
    await flush();
    expect(store.get("L1")?.status).toBe("Open");

    const before = client.community.gateStatus.mock.calls.length;
    stream.push({ kind: "event", id: "2", type: "device.offline", data: {}, payload: {} });
    await flush();
    stream.push({ kind: "reset", reason: "cursor_expired" });
    await flush();
    expect(client.community.gateStatus.mock.calls.length).toBe(before + 2);
    live.stop();
  });

  it("falls back to polling on a stream error, with a hint for the stream limit, then retries", async () => {
    const { live, client, log, stream } = setup();
    await live.start();
    await flush();
    stream.fail(new RateLimitError("limit", { status: 429, code: "stream_limit" }));
    await flush();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("3 live streams"));

    const before = client.community.gateStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); // stream retry → re-seed + reconnect
    expect(client.community.gateStatus.mock.calls.length).toBeGreaterThan(before);
    expect(stream.streamEvents).toHaveBeenCalledTimes(2);
    live.stop();
  });

  it("stops the stream on an auth error", async () => {
    const { live, log, stream } = setup();
    await live.start();
    await flush();
    stream.fail(new AuthenticationError("bad", { status: 401, code: "invalid_api_key" }));
    await flush();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Live updates stopped"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(stream.streamEvents).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it("polling mode never opens the stream", async () => {
    const { live, client, stream } = setup({ liveUpdates: "polling", holdOpens: false });
    await live.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stream.streamEvents).not.toHaveBeenCalled();
    expect(client.community.holdOpens).not.toHaveBeenCalled();
    expect(client.community.gateStatus).toHaveBeenCalledTimes(3);
    live.stop();
  });

  it("warns once per outage and announces recovery", async () => {
    const { live, client, log } = setup({ liveUpdates: "polling" });
    client.community.gateStatus.mockRejectedValue(new Error("down"));
    await live.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    client.community.gateStatus.mockResolvedValue({ latches: [], raw: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.info).toHaveBeenCalledWith("Nimbio status reads recovered");
    live.stop();
  });
});

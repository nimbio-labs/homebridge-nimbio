// Regression tests for the 2026-10-12 code review of the plugin. Each block
// names the defect it pins down.
import { AuthenticationError, NimbioClient, RateLimitError } from "@nimbio/community-api";
import * as hap from "@homebridge/hap-nodejs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateAccessory, SENSED_SETTLE_MS } from "../src/accessories/gate.js";
import { LockAccessory, UNLOCK_SETTLE_MS } from "../src/accessories/lock.js";
import type { PluginContext } from "../src/context.js";
import { DOOR, LOCK, TARGET } from "../src/doorState.js";
import { LiveUpdater } from "../src/live.js";
import { Opener } from "../src/opener.js";
import { NimbioPlatform } from "../src/platform.js";
import { PLATFORM_NAME } from "../src/settings.js";
import { StateStore } from "../src/state.js";
import { StreamProbe } from "../src/streamProbe.js";
import {
  FakeAccessory, flush, latch, makeApi, makeConfig, makeLog, makeStream, me, openResult, streamEvent,
} from "./helpers.js";

const { Characteristic: C, Service: S } = hap;
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
afterEach(() => vi.useRealTimers());

// --------------------------------------------------------------------------
// #1 Stream events were read from the envelope (ev.data), so none applied.
// Driven through the real SDK client and its SSE parser, not a hand-built
// event, so the test cannot share the plugin's assumptions about the shape.
// --------------------------------------------------------------------------
describe("stream events through the real SDK", () => {
  function sseFetch(frames: string[]) {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/events/stream")) {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const f of frames) controller.enqueue(enc.encode(f));
            // Stay open like a real stream until the plugin aborts it.
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.includes("/v1/community/gate-status")) {
        return json({ latches: [{ latch_id: "L1", latch_name: "Front", status: "Closed", possible_statuses: [] }] });
      }
      if (url.includes("/v1/community/hold-opens")) {
        return json({ hold_opens: { L1: { latch_id: "L1", held_open: false, manual: false } } });
      }
      return new Response("{}", { status: 404 });
    });
  }

  const frame = (id: string, event: string, data: Record<string, unknown>) =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({ event, id: `evt_${id}`, community_id: "c1", data })}\n\n`;

  it("applies sense_line.changed and hold_open.changed from real SSE frames", async () => {
    const fetch = sseFetch([
      frame("1", "sense_line.changed", { latch_id: "L1", status_label: "Open" }),
      frame("2", "hold_open.changed", { latch_id: "L1", held_open: true, manual: true }),
    ]);
    const client = new NimbioClient("nimbio_test_x", { environment: "dev", fetch: fetch as never, maxRetries: 0 });
    const store = new StateStore();
    const live = new LiveUpdater(client, store, makeLog(), {
      liveUpdates: "stream", pollSeconds: 60, gateStatus: true, holdOpens: true,
    });
    await live.start();
    await vi.waitFor(() => {
      expect(store.get("L1")).toMatchObject({ status: "Open", heldOpen: true, manualHoldOpen: true });
    });
    live.stop();
  });
});

// --------------------------------------------------------------------------
// Sensed gate timers: #2 (settle could land on Opening) and #9 (a settle timer
// armed after a settled event mislabelled a later closing gate).
// --------------------------------------------------------------------------
describe("sensed gate settling", () => {
  function setup() {
    const client = { community: { open: vi.fn().mockResolvedValue(openResult(false)) } };
    const log = makeLog();
    const store = new StateStore();
    store.seedGateStatus({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed", "Moving"])], raw: {} } as never);
    const ctx: PluginContext = {
      api: makeApi(), log, config: makeConfig(), client: client as never,
      opener: new Opener(client as never, log, "manager"), store,
    };
    const a = new FakeAccessory("Front", hap.uuid.generate("gate-settle"));
    const h = new GateAccessory(ctx, a as never, { latchId: "L1", name: "Front", kind: "door" });
    const svc = a.getService(S.GarageDoorOpener)!;
    const emit = (status_label: string) => store.applyEvent(streamEvent("sense_line.changed", { latch_id: "L1", status_label }));
    return { client, svc, emit, h };
  }

  it("#2 a lost final event after Moving settles to Closed, not Opening", () => {
    fakeTimers();
    const { svc, emit, h } = setup();
    emit("Moving");
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPENING);
    vi.advanceTimersByTime(SENSED_SETTLE_MS);
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.CLOSED);
    expect(svc.getCharacteristic(C.TargetDoorState).value).toBe(TARGET.CLOSED);
    h.dispose();
  });

  it("#2 Malfunction while moving settles to Closed with the obstruction flag", () => {
    fakeTimers();
    const { svc, emit, h } = setup();
    emit("Moving");
    emit("Malfunction");
    vi.advanceTimersByTime(SENSED_SETTLE_MS);
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.CLOSED);
    expect(svc.getCharacteristic(C.TargetDoorState).value).toBe(TARGET.CLOSED);
    expect(svc.getCharacteristic(C.ObstructionDetected).value).toBe(true);
    h.dispose();
  });

  it("#9 an Open event during the open means no stale settle timer; a later close reads as closing", async () => {
    fakeTimers();
    const { client, svc, emit, h } = setup();
    // HAP's Accessory keeps an internal timer of its own; count only ours.
    const base = vi.getTimerCount();
    let release!: () => void;
    client.community.open.mockReturnValueOnce(new Promise((r) => { release = () => r(openResult(false)); }));
    await svc.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.OPEN);
    emit("Open"); // arrives while the box is still confirming
    release();
    await flush();
    expect(vi.getTimerCount()).toBe(base);
    emit("Moving");
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.CLOSING);
    vi.advanceTimersByTime(SENSED_SETTLE_MS); // final "Closed" lost
    // Back to the last real position (Open) — never Opening, never invented.
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPEN);
    h.dispose();
  });
});

// --------------------------------------------------------------------------
// #8 A failed unlock orphaned the earlier settle timer.
// --------------------------------------------------------------------------
describe("lock timers", () => {
  it("#8 no timer survives dispose after unlock → failed unlock", async () => {
    fakeTimers();
    const client = { community: { open: vi.fn().mockResolvedValueOnce(openResult(false)).mockRejectedValueOnce(new Error("x")) } };
    const log = makeLog();
    const store = new StateStore();
    store.seedGateStatus({ latches: [latch("L2", "Door", "Locked", ["Locked", "Unlocked"])], raw: {} } as never);
    const ctx: PluginContext = {
      api: makeApi(), log, config: makeConfig(), client: client as never,
      opener: new Opener(client as never, log, "manager"), store,
    };
    const a = new FakeAccessory("Door", hap.uuid.generate("lock-timers"));
    const h = new LockAccessory(ctx, a as never, { latchId: "L2", name: "Door", kind: "lock" });
    const t = a.getService(S.LockMechanism)!.getCharacteristic(C.LockTargetState);
    await t.handleSetRequest(LOCK.UNSECURED);
    await flush(); // succeeds → 30s settle armed
    vi.advanceTimersByTime(UNLOCK_SETTLE_MS / 2);
    await t.handleSetRequest(LOCK.UNSECURED);
    await flush(); // fails → its own timer; the 30s one must be gone
    expect(vi.getTimerCount()).toBe(1);
    h.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// #4 / #5 / #7 live updater behaviour.
// --------------------------------------------------------------------------
describe("live updater", () => {
  const status = () => ({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed"])], raw: {} });

  it("#4 a permanent refusal warns once and backs off", async () => {
    fakeTimers();
    // Refused at connect, like the SDK throwing an HTTP error before any event.
    const streamEvents = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new RateLimitError("limit", { status: 429, code: "stream_limit" })),
      }),
    }));
    const client = { community: { gateStatus: vi.fn().mockResolvedValue(status()), holdOpens: vi.fn(), streamEvents } };
    const log = makeLog();
    const live = new LiveUpdater(client as never, new StateStore(), log, {
      liveUpdates: "stream", pollSeconds: 600, gateStatus: true, holdOpens: false, streamRetryMs: 1000,
    });
    await live.start();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(streamEvents).toHaveBeenCalledTimes(4); // attempts at 0, 1s, 3s, 7s
    expect(log.warn).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it("#5 polling stops once a reconnected stream gets its 200, even with no events", async () => {
    fakeTimers();
    const stream = makeStream();
    const probe = new StreamProbe();
    const gateStatus = vi.fn().mockResolvedValue(status());
    const client = { community: { gateStatus, holdOpens: vi.fn(), streamEvents: stream.streamEvents } };
    const log = makeLog();
    const live = new LiveUpdater(client as never, new StateStore(), log, {
      liveUpdates: "stream", pollSeconds: 30, gateStatus: true, holdOpens: false, streamRetryMs: 1000, probe,
    });
    await live.start();
    stream.fail(new Error("refused"));
    await vi.advanceTimersByTimeAsync(1000); // retry
    await probe.wrap(async () => new Response(null, { status: 200 }))("https://api.nimbio.dev/v1/events/stream?events=x");
    expect(log.info).toHaveBeenCalledWith("Live updates: event stream reconnected");
    const after = gateStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // no events, well under the 15-min safety resync
    expect(gateStatus.mock.calls.length).toBe(after);
    live.stop();
  });

  it("#7 start({ gateStatusSeeded }) does not read gate status again", async () => {
    const gateStatus = vi.fn().mockResolvedValue(status());
    const holdOpens = vi.fn().mockResolvedValue({ latches: {}, raw: {} });
    const live = new LiveUpdater({ community: { gateStatus, holdOpens, streamEvents: makeStream().streamEvents } } as never,
      new StateStore(), makeLog(), { liveUpdates: "polling", pollSeconds: 60, gateStatus: true, holdOpens: true });
    await live.start({ gateStatusSeeded: true });
    expect(gateStatus).not.toHaveBeenCalled();
    expect(holdOpens).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it("#3 stop() during the initial seed opens no stream", async () => {
    let release!: () => void;
    const gateStatus = vi.fn().mockReturnValue(new Promise((r) => { release = () => r(status()); }));
    const stream = makeStream();
    const live = new LiveUpdater({ community: { gateStatus, holdOpens: vi.fn(), streamEvents: stream.streamEvents } } as never,
      new StateStore(), makeLog(), { liveUpdates: "stream", pollSeconds: 60, gateStatus: true, holdOpens: false });
    const started = live.start();
    live.stop();
    release();
    await started;
    await flush();
    expect(stream.streamEvents).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Platform: #3 shutdown during startup, #6 rejected key leaves usable-looking
// tiles, #7 one gate-status read at startup.
// --------------------------------------------------------------------------
describe("platform lifecycle", () => {
  function client(meImpl: () => Promise<unknown>) {
    const stream = makeStream();
    return {
      stream,
      me: vi.fn(meImpl),
      account: { keys: vi.fn().mockResolvedValue([]), open: vi.fn() },
      community: {
        gateStatus: vi.fn().mockResolvedValue({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed"])], raw: {} }),
        holdOpens: vi.fn().mockResolvedValue({ latches: {}, raw: {} }),
        info: vi.fn(), open: vi.fn(), setHoldOpen: vi.fn(),
        streamEvents: stream.streamEvents,
      },
    };
  }
  function boot(c: ReturnType<typeof client>, cached: FakeAccessory[] = []) {
    const api = makeApi();
    const log = makeLog();
    const platform = new NimbioPlatform(log, { platform: PLATFORM_NAME, apiKey: "nimbio_test_x" }, api, {
      createClient: () => c as never, retryMs: 10,
    });
    for (const a of cached) platform.configureAccessory(a as never);
    return { api, log, platform };
  }

  it("#3 shutdown while me() is in flight builds nothing", async () => {
    let release!: (v: unknown) => void;
    const c = client(() => new Promise((r) => { release = r; }));
    const { api } = boot(c);
    api.emit("didFinishLaunching");
    api.emit("shutdown");
    release(me("community", ["open", "gate_status", "hold_opens"]));
    await flush();
    await flush();
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(c.community.gateStatus).not.toHaveBeenCalled();
    expect(c.community.streamEvents).not.toHaveBeenCalled();
  });

  it("#3 shutdown during a failed start schedules no retry", async () => {
    let reject!: (e: unknown) => void;
    const c = client(() => new Promise((_, r) => { reject = r; }));
    const { api, platform } = boot(c);
    api.emit("didFinishLaunching");
    api.emit("shutdown");
    reject(new Error("network"));
    await flush();
    // No retry may even be scheduled once shutdown has run.
    expect((platform as unknown as { retryTimer?: unknown }).retryTimer).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(c.me).toHaveBeenCalledTimes(1);
  });

  it("#6 a rejected key makes cached tiles report No Response", async () => {
    const c = client(() => Promise.reject(new AuthenticationError("bad", { status: 401, code: "invalid_api_key" })));
    const cached = new FakeAccessory("Front", hap.uuid.generate("nimbio:gate:L1"));
    cached.addService(S.GarageDoorOpener, "Front");
    const { api } = boot(c, [cached]);
    api.emit("didFinishLaunching");
    await flush();
    const target = cached.getService(S.GarageDoorOpener)!.getCharacteristic(C.TargetDoorState);
    await expect(target.handleSetRequest(TARGET.OPEN)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(
      cached.getService(S.GarageDoorOpener)!.getCharacteristic(C.CurrentDoorState).handleGetRequest(),
    ).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it("#6 once the key is confirmed, the same cached tile works again", async () => {
    const c = client(() => Promise.resolve(me("community", ["open", "gate_status"])));
    const cached = new FakeAccessory("Front", hap.uuid.generate("nimbio:gate:L1"));
    cached.addService(S.GarageDoorOpener, "Front");
    const { api, platform } = boot(c, [cached]);
    api.emit("didFinishLaunching");
    await flush();
    await flush();
    await expect(
      cached.getService(S.GarageDoorOpener)!.getCharacteristic(C.CurrentDoorState).handleGetRequest(),
    ).resolves.toBe(DOOR.CLOSED);
    platform.stop();
  });

  it("#7 a manager start reads gate status once", async () => {
    const c = client(() => Promise.resolve(me("community", ["open", "gate_status", "hold_opens"])));
    const { api, platform } = boot(c);
    api.emit("didFinishLaunching");
    await flush();
    await flush();
    expect(c.community.gateStatus).toHaveBeenCalledTimes(1);
    expect(c.community.holdOpens).toHaveBeenCalledTimes(1);
    platform.stop();
  });
});

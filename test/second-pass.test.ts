// Regression tests for the second code-review pass (2026-10-12).
import * as hap from "@homebridge/hap-nodejs";
import { RateLimitError } from "@nimbio/community-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateAccessory } from "../src/accessories/gate.js";
import type { PluginContext } from "../src/context.js";
import { DOOR, TARGET } from "../src/doorState.js";
import { LiveUpdater } from "../src/live.js";
import { Opener } from "../src/opener.js";
import { NimbioPlatform } from "../src/platform.js";
import { PLATFORM_NAME } from "../src/settings.js";
import { StateStore } from "../src/state.js";
import { STREAM_PATH, StreamProbe } from "../src/streamProbe.js";
import { FakeAccessory, flush, latch, makeApi, makeConfig, makeLog, makeStream, me, streamEvent } from "./helpers.js";

const { Characteristic: C, Service: S } = hap;
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
afterEach(() => vi.useRealTimers());
const status = (s = "Closed") => ({ latches: [latch("L1", "Front", s, ["Open", "Closed"])], raw: {} });

describe("stream health is a real 200, not elapsed time (findings 1, 2, 6)", () => {
  it("the probe passes every response through and fires only on a 200 from the stream path", async () => {
    const probe = new StreamProbe();
    const opened = vi.fn();
    probe.onOpen(opened);
    const res200 = new Response("x", { status: 200 });
    const inner = vi.fn(async () => res200);
    const f = probe.wrap(inner);
    expect(await f("https://api.nimbio.com/v1/community/gate-status", { method: "GET" })).toBe(res200);
    expect(opened).not.toHaveBeenCalled();
    await f(`https://api.nimbio.com${STREAM_PATH}?events=a`);
    expect(opened).toHaveBeenCalledTimes(1);
    const g = probe.wrap(async () => new Response(null, { status: 429 }));
    await g(`https://api.nimbio.com${STREAM_PATH}`);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith("https://api.nimbio.com/v1/community/gate-status", { method: "GET" });
  });

  it("a stream that never connects keeps polling and never claims recovery", async () => {
    fakeTimers();
    const stream = makeStream(); // stays open, yields nothing, no 200 reported
    const gateStatus = vi.fn().mockResolvedValue(status());
    const log = makeLog();
    const live = new LiveUpdater({ community: { gateStatus, holdOpens: vi.fn(), streamEvents: stream.streamEvents } } as never,
      new StateStore(), log, { liveUpdates: "stream", pollSeconds: 30, gateStatus: true, holdOpens: false, streamRetryMs: 1000, probe: new StreamProbe() });
    await live.start();
    stream.fail(new Error("refused"));
    await vi.advanceTimersByTimeAsync(1000); // retried; this attempt hangs
    const after = gateStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(gateStatus.mock.calls.length).toBeGreaterThanOrEqual(after + 9); // polling still every 30s
    expect(log.info).not.toHaveBeenCalledWith("Live updates: event stream reconnected");
    live.stop();
  });

  it("slow failures (>15s each) still back off and warn once", async () => {
    fakeTimers();
    const err = new RateLimitError("busy", { status: 503, code: "unavailable" });
    const streamEvents = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((_, rej) => setTimeout(() => rej(err), 20_000)) }),
    }));
    const log = makeLog();
    const live = new LiveUpdater({ community: { gateStatus: vi.fn().mockResolvedValue(status()), holdOpens: vi.fn(), streamEvents } } as never,
      new StateStore(), log, { liveUpdates: "stream", pollSeconds: 600, gateStatus: true, holdOpens: false, streamRetryMs: 1000, probe: new StreamProbe() });
    await live.start();
    // attempts at 0, 21s (fail 20 + wait 1), 43s (+20 +2), 67s (+20 +4)
    await vi.advanceTimersByTimeAsync(68_000);
    expect(streamEvents).toHaveBeenCalledTimes(4);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalledWith("Live updates: event stream reconnected");
    live.stop();
  });

  it("the platform hands the client a probing fetch and the probe to the live updater", async () => {
    const stream = makeStream();
    let options: { fetch?: unknown } = {};
    const client = {
      me: vi.fn().mockResolvedValue(me("community", ["open", "gate_status"])),
      community: { gateStatus: vi.fn().mockResolvedValue(status()), holdOpens: vi.fn(), streamEvents: stream.streamEvents, info: vi.fn() },
      account: { keys: vi.fn() },
    };
    const api = makeApi();
    const platform = new NimbioPlatform(makeLog(), { platform: PLATFORM_NAME, apiKey: "nimbio_test_x" }, api, {
      createClient: (_k, o) => { options = o; return client as never; },
    });
    api.emit("didFinishLaunching");
    await flush();
    await flush();
    expect(typeof options.fetch).toBe("function");
    platform.stop();
  });
});

describe("status reads never clobber newer events (finding 5)", () => {
  it("a read that started before an event does not overwrite it", async () => {
    let release!: (v: unknown) => void;
    const gateStatus = vi.fn().mockReturnValueOnce(new Promise((r) => { release = r; }));
    const store = new StateStore();
    store.seedGateStatus(status("Closed") as never);
    const live = new LiveUpdater({ community: { gateStatus, holdOpens: vi.fn(), streamEvents: makeStream().streamEvents } } as never,
      store, makeLog(), { liveUpdates: "polling", pollSeconds: 600, gateStatus: true, holdOpens: false });
    const read = live.seed();
    store.applyEvent(streamEvent("sense_line.changed", { latch_id: "L1", status_label: "Open" }));
    release(status("Closed")); // the stale read lands after the event
    await read;
    expect(store.get("L1")?.status).toBe("Open");
  });

  it("overlapping callers share one read", async () => {
    let release!: (v: unknown) => void;
    const gateStatus = vi.fn().mockReturnValue(new Promise((r) => { release = r; }));
    const live = new LiveUpdater({ community: { gateStatus, holdOpens: vi.fn(), streamEvents: makeStream().streamEvents } } as never,
      new StateStore(), makeLog(), { liveUpdates: "polling", pollSeconds: 600, gateStatus: true, holdOpens: false });
    const a = live.seed();
    const b = live.seed();
    release(status());
    await Promise.all([a, b]);
    expect(gateStatus).toHaveBeenCalledTimes(1);
  });

  it("a local hold-open write is not undone by an in-flight read", async () => {
    let release!: (v: unknown) => void;
    const holdOpens = vi.fn().mockReturnValueOnce(new Promise((r) => { release = r; }));
    const store = new StateStore();
    const live = new LiveUpdater({ community: { gateStatus: vi.fn(), holdOpens, streamEvents: makeStream().streamEvents } } as never,
      store, makeLog(), { liveUpdates: "polling", pollSeconds: 600, gateStatus: false, holdOpens: true });
    const read = live.seed();
    store.setManualHoldOpen("L1", true);
    release({ latches: { L1: { latchId: "L1", heldOpen: false, manual: false } }, raw: {} });
    await read;
    expect(store.get("L1")?.manualHoldOpen).toBe(true);
  });
});

describe("a failed open restores the last real position (finding 3)", () => {
  it("held-open gate, box goes Unknown, open fails → still Open, not Closed", async () => {
    fakeTimers();
    const client = { community: { open: vi.fn().mockRejectedValue(new Error("offline")) } };
    const log = makeLog();
    const store = new StateStore();
    store.seedGateStatus(status("Open") as never);
    const ctx: PluginContext = {
      api: makeApi(), log, config: makeConfig(), client: client as never,
      opener: new Opener(client as never, log, "manager"), store,
    };
    const a = new FakeAccessory("Front", hap.uuid.generate("held"));
    const h = new GateAccessory(ctx, a as never, { latchId: "L1", name: "Front", kind: "door" });
    const svc = a.getService(S.GarageDoorOpener)!;
    store.applyEvent(streamEvent("sense_line.changed", { latch_id: "L1", status_label: "Unknown" }));
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPEN);
    await svc.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.OPEN);
    await flush();
    vi.advanceTimersByTime(5000);
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPEN);
    expect(svc.getCharacteristic(C.TargetDoorState).value).toBe(TARGET.OPEN);
    h.dispose();
  });
});

describe("cached tiles before and after start (findings 4, 7)", () => {
  const cachedGate = () => {
    const a = new FakeAccessory("Front", hap.uuid.generate("nimbio:gate:L1"));
    const svc = a.addService(S.GarageDoorOpener, "Front");
    // An optional characteristic no handler registers — it must not keep the stub.
    svc.addOptionalCharacteristic(C.LockCurrentState);
    svc.getCharacteristic(C.LockCurrentState).updateValue(1);
    return a;
  };

  it("an unconfigured plugin's cached tiles report No Response", async () => {
    const api = makeApi();
    const platform = new NimbioPlatform(makeLog(), { platform: PLATFORM_NAME }, api);
    const a = cachedGate();
    platform.configureAccessory(a as never);
    await expect(a.getService(S.GarageDoorOpener)!.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.OPEN))
      .rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it("after a confirmed start no stub lingers, even on characteristics no handler touches", async () => {
    const client = {
      me: vi.fn().mockResolvedValue(me("account", ["open"])),
      account: { keys: vi.fn().mockResolvedValue([{ id: "k1", name: "Home", disabled: false, pending: false, latches: [{ id: "L1", name: "Front" }] }]), open: vi.fn() },
      community: {},
    };
    const api = makeApi();
    const platform = new NimbioPlatform(makeLog(), { platform: PLATFORM_NAME, apiKey: "nimbio_test_x" }, api, { createClient: () => client as never });
    const a = cachedGate();
    platform.configureAccessory(a as never);
    api.emit("didFinishLaunching");
    await flush();
    await flush();
    const svc = a.getService(S.GarageDoorOpener)!;
    await expect(svc.getCharacteristic(C.CurrentDoorState).handleGetRequest()).resolves.toBe(DOOR.CLOSED);
    await expect(svc.getCharacteristic(C.LockCurrentState).handleGetRequest()).resolves.toBe(1);
    platform.stop();
  });
});

import { GateNotOpenedError } from "@nimbio/community-api";
import * as hap from "@homebridge/hap-nodejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateAccessory, SENSED_SETTLE_MS } from "../src/accessories/gate.js";
import { HoldOpenAccessory } from "../src/accessories/holdOpen.js";
import { LockAccessory, UNLOCK_SETTLE_MS } from "../src/accessories/lock.js";
import type { PluginContext } from "../src/context.js";
import { DOOR, LOCK, TARGET } from "../src/doorState.js";
import type { GateSpec } from "../src/inventory.js";
import { OPEN_NOTE, Opener } from "../src/opener.js";
import { StateStore } from "../src/state.js";
import { FakeAccessory, flush, latch, makeApi, makeConfig, makeLog, openResult, streamEvent } from "./helpers.js";

const { Characteristic: C, Service: S } = hap;

function setup(mode: "member" | "manager" = "member") {
  const client = {
    account: { open: vi.fn().mockResolvedValue(openResult()) },
    community: {
      open: vi.fn().mockResolvedValue(openResult(false)),
      setHoldOpen: vi.fn().mockResolvedValue({ result: "ok", simulated: false }),
    },
  };
  const log = makeLog();
  const store = new StateStore();
  const ctx: PluginContext = {
    api: makeApi(),
    log,
    config: makeConfig(),
    client: client as never,
    opener: new Opener(client as never, log, mode),
    store,
  };
  return { ctx, client, log, store };
}

const acc = () => new FakeAccessory("Front", hap.uuid.generate(String(Math.random())));
const value = (a: FakeAccessory, svc: typeof S.GarageDoorOpener | typeof S.LockMechanism | typeof S.Switch, ch: typeof C.On) =>
  a.getService(svc)!.getCharacteristic(ch).value;

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

describe("Opener", () => {
  it("member opens through the key with a note and a fresh idempotency key", async () => {
    const { ctx, client, log } = setup("member");
    const gate: GateSpec = { latchId: "L1", name: "Front", kind: "momentary", keyId: "k1" };
    await ctx.opener.open(gate);
    await ctx.opener.open(gate);
    const [a, b] = client.account.open.mock.calls;
    expect(a?.slice(0, 2)).toEqual(["k1", "L1"]);
    expect(a?.[2].note).toBe(OPEN_NOTE);
    expect(a?.[2].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(a?.[2].idempotencyKey).not.toBe(b?.[2].idempotencyKey);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("simulated"));
  });

  it("manager opens the latch directly; a member gate with no key id fails", async () => {
    const { ctx, client } = setup("manager");
    await ctx.opener.open({ latchId: "L1", name: "Front", kind: "door" });
    expect(client.community.open).toHaveBeenCalledWith("L1", expect.objectContaining({ note: OPEN_NOTE }));

    const member = setup("member");
    await expect(member.ctx.opener.open({ latchId: "L1", name: "Front", kind: "momentary" })).rejects.toThrow(/no Nimbio key/);
  });
});

describe("GateAccessory — momentary", () => {
  const gate: GateSpec = { latchId: "L1", name: "Front", kind: "momentary", keyId: "k1" };

  it("rests closed, opens, then resets after momentaryResetSeconds", async () => {
    const { ctx, client } = setup();
    let release!: () => void;
    client.account.open.mockReturnValueOnce(new Promise((r) => { release = () => r(openResult()); }));
    const a = acc();
    new GateAccessory(ctx, a as never, gate);
    expect(value(a, S.GarageDoorOpener, C.CurrentDoorState)).toBe(DOOR.CLOSED);

    await a.getService(S.GarageDoorOpener)!.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.OPEN);
    expect(value(a, S.GarageDoorOpener, C.CurrentDoorState)).toBe(DOOR.OPENING);
    release();
    await flush();
    expect(client.account.open).toHaveBeenCalledTimes(1);
    expect(value(a, S.GarageDoorOpener, C.CurrentDoorState)).toBe(DOOR.OPEN);

    vi.advanceTimersByTime(5000);
    expect(value(a, S.GarageDoorOpener, C.CurrentDoorState)).toBe(DOOR.CLOSED);
    expect(value(a, S.GarageDoorOpener, C.TargetDoorState)).toBe(TARGET.CLOSED);
  });

  it("ignores a second open while one is in flight", async () => {
    const { ctx, client } = setup();
    let release!: () => void;
    client.account.open.mockReturnValueOnce(new Promise((r) => { release = () => r(openResult()); }));
    const a = acc();
    new GateAccessory(ctx, a as never, gate);
    const t = a.getService(S.GarageDoorOpener)!.getCharacteristic(C.TargetDoorState);
    await t.handleSetRequest(TARGET.OPEN);
    await t.handleSetRequest(TARGET.OPEN);
    release();
    await flush();
    expect(client.account.open).toHaveBeenCalledTimes(1);
  });

  it("a failed open is logged and returns to closed", async () => {
    const { ctx, client, log } = setup();
    client.account.open.mockRejectedValueOnce(new GateNotOpenedError("no", { status: 504, code: "gate_not_opened" }));
    const a = acc();
    new GateAccessory(ctx, a as never, gate);
    await a.getService(S.GarageDoorOpener)!.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.OPEN);
    await flush();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("did not confirm"));
    vi.advanceTimersByTime(5000);
    expect(value(a, S.GarageDoorOpener, C.CurrentDoorState)).toBe(DOOR.CLOSED);
    expect(value(a, S.GarageDoorOpener, C.TargetDoorState)).toBe(TARGET.CLOSED);
  });

  it("a close request on a momentary gate just settles it closed", async () => {
    const { ctx } = setup();
    const a = acc();
    new GateAccessory(ctx, a as never, gate);
    const t = a.getService(S.GarageDoorOpener)!.getCharacteristic(C.TargetDoorState);
    await t.handleSetRequest(TARGET.OPEN);
    await flush();
    await t.handleSetRequest(TARGET.CLOSED);
    expect(value(a, S.GarageDoorOpener, C.CurrentDoorState)).toBe(DOOR.CLOSED);
  });
});

describe("GateAccessory — sensed", () => {
  const gate: GateSpec = { latchId: "L1", name: "Front", kind: "door" };

  it("follows live status, including Moving and Malfunction", () => {
    const { ctx, store } = setup("manager");
    store.seedGateStatus({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed", "Moving"])], raw: {} } as never);
    const a = acc();
    new GateAccessory(ctx, a as never, gate);
    const svc = a.getService(S.GarageDoorOpener)!;
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.CLOSED);

    const emit = (status_label: string) =>
      store.applyEvent(streamEvent("sense_line.changed", { latch_id: "L1", status_label }));
    emit("Moving");
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPENING);
    emit("Open");
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPEN);
    emit("Unknown");
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPEN);
    emit("Malfunction");
    expect(svc.getCharacteristic(C.ObstructionDetected).value).toBe(true);
    emit("Closed");
    expect(svc.getCharacteristic(C.ObstructionDetected).value).toBe(false);
    expect(svc.getCharacteristic(C.TargetDoorState).value).toBe(TARGET.CLOSED);
  });

  it("after an open with no status event, falls back to the last real reading", async () => {
    const { ctx, store, client } = setup("manager");
    store.seedGateStatus({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed"])], raw: {} } as never);
    const a = acc();
    new GateAccessory(ctx, a as never, gate);
    const svc = a.getService(S.GarageDoorOpener)!;
    await svc.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.OPEN);
    await flush();
    expect(client.community.open).toHaveBeenCalled();
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.OPENING);
    vi.advanceTimersByTime(SENSED_SETTLE_MS);
    expect(svc.getCharacteristic(C.CurrentDoorState).value).toBe(DOOR.CLOSED);
  });

  it("a close request is not sent and the target snaps back", async () => {
    const { ctx, store, client, log } = setup("manager");
    store.seedGateStatus({ latches: [latch("L1", "Front", "Open", ["Open", "Closed"])], raw: {} } as never);
    const a = acc();
    const h = new GateAccessory(ctx, a as never, gate);
    const svc = a.getService(S.GarageDoorOpener)!;
    await svc.getCharacteristic(C.TargetDoorState).handleSetRequest(TARGET.CLOSED);
    await flush();
    expect(client.community.open).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("close on their own"));
    expect(svc.getCharacteristic(C.TargetDoorState).value).toBe(TARGET.OPEN);
    h.dispose();
  });
});

describe("LockAccessory", () => {
  const gate: GateSpec = { latchId: "L2", name: "Door", kind: "lock" };

  it("unlock opens; target follows sensed state; lock requests snap back", async () => {
    const { ctx, store, client } = setup("manager");
    store.seedGateStatus({ latches: [latch("L2", "Door", "Locked", ["Locked", "Unlocked"])], raw: {} } as never);
    const a = acc();
    const h = new LockAccessory(ctx, a as never, gate);
    const svc = a.getService(S.LockMechanism)!;
    expect(svc.getCharacteristic(C.LockCurrentState).value).toBe(LOCK.SECURED);

    await svc.getCharacteristic(C.LockTargetState).handleSetRequest(LOCK.UNSECURED);
    await flush();
    expect(client.community.open).toHaveBeenCalledWith("L2", expect.anything());

    store.applyEvent(streamEvent("sense_line.changed", { latch_id: "L2", status_label: "Unlocked" }));
    expect(svc.getCharacteristic(C.LockCurrentState).value).toBe(LOCK.UNSECURED);

    await svc.getCharacteristic(C.LockTargetState).handleSetRequest(LOCK.SECURED);
    await flush();
    expect(svc.getCharacteristic(C.LockTargetState).value).toBe(LOCK.UNSECURED);
    h.dispose();
  });

  it("an unlock with no status change snaps back to secured", async () => {
    const { ctx, store } = setup("manager");
    store.seedGateStatus({ latches: [latch("L2", "Door", "Locked", ["Locked", "Unlocked"])], raw: {} } as never);
    const a = acc();
    new LockAccessory(ctx, a as never, gate);
    const svc = a.getService(S.LockMechanism)!;
    await svc.getCharacteristic(C.LockTargetState).handleSetRequest(LOCK.UNSECURED);
    await flush();
    vi.advanceTimersByTime(UNLOCK_SETTLE_MS);
    expect(svc.getCharacteristic(C.LockTargetState).value).toBe(LOCK.SECURED);
  });

  it("a failed unlock snaps back", async () => {
    const { ctx, client, log } = setup("manager");
    client.community.open.mockRejectedValueOnce(new Error("boom"));
    const a = acc();
    new LockAccessory(ctx, a as never, gate);
    const svc = a.getService(S.LockMechanism)!;
    await svc.getCharacteristic(C.LockTargetState).handleSetRequest(LOCK.UNSECURED);
    await flush();
    expect(log.error).toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(svc.getCharacteristic(C.LockTargetState).value).toBe(LOCK.SECURED);
  });
});

describe("HoldOpenAccessory", () => {
  const gate: GateSpec = { latchId: "L1", name: "Front", kind: "door" };

  it("reflects the manual flag and writes through", async () => {
    const { ctx, store, client } = setup("manager");
    const a = acc();
    const h = new HoldOpenAccessory(ctx, a as never, gate);
    const on = a.getService(S.Switch)!.getCharacteristic(C.On);
    expect(on.value).toBe(false);

    await on.handleSetRequest(true);
    expect(client.community.setHoldOpen).toHaveBeenCalledWith("L1", true);
    expect(store.get("L1")?.manualHoldOpen).toBe(true);

    // A scheduled window holding it open does not turn the manual switch on.
    store.applyEvent(streamEvent("hold_open.changed", { latch_id: "L1", held_open: true, manual: false }, "2"));
    expect(on.value).toBe(false);
    h.dispose();
  });

  it("a failed write reports an error to HomeKit", async () => {
    const { ctx, client, log } = setup("manager");
    client.community.setHoldOpen.mockRejectedValueOnce(new Error("nope"));
    const a = acc();
    new HoldOpenAccessory(ctx, a as never, gate);
    await expect(a.getService(S.Switch)!.getCharacteristic(C.On).handleSetRequest(true)).rejects.toBeDefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("hold-open on failed"));
  });
});

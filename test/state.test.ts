import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/state.js";
import { DOOR, LOCK, TARGET, doorReadingFor, lockStateFor } from "../src/doorState.js";
import { excludeLatches, managerInventory, managerInventoryWithoutStatus, memberInventory } from "../src/inventory.js";
import { latch } from "./helpers.js";

const ev = (type: string, data: Record<string, unknown>) => ({ kind: "event" as const, id: "1", type, data, payload: {} });

describe("StateStore", () => {
  it("seeds, applies events, and notifies subscribers", () => {
    const store = new StateStore();
    store.seedGateStatus({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed"])], raw: {} } as never);
    const fn = vi.fn();
    store.subscribe("L1", fn);

    expect(store.applyEvent(ev("sense_line.changed", { latch_id: "L1", status_label: "Moving" }))).toBe("applied");
    expect(store.get("L1")?.status).toBe("Moving");
    expect(fn).toHaveBeenCalledTimes(1);

    expect(store.applyEvent(ev("hold_open.changed", { latch_id: "L1", held_open: true, manual: false }))).toBe("applied");
    expect(store.get("L1")).toMatchObject({ heldOpen: true, manualHoldOpen: false });
  });

  it("ignores unknown latches and unrelated events; device events ask for a resync", () => {
    const store = new StateStore();
    expect(store.applyEvent(ev("sense_line.changed", { latch_id: "nope", status_label: "Open" }))).toBe("ignored");
    expect(store.applyEvent(ev("hold_open.changed", { latch_id: "nope" }))).toBe("ignored");
    expect(store.applyEvent(ev("member.requested", {}))).toBe("ignored");
    expect(store.applyEvent(ev("device.offline", { box_id: "b" }))).toBe("resync");
    expect(store.applyEvent(ev("device.online", { box_id: "b" }))).toBe("resync");
  });

  it("seeds hold-opens keyed by latch and unsubscribes", () => {
    const store = new StateStore();
    const fn = vi.fn();
    const off = store.subscribe("L2", fn);
    store.seedHoldOpens({
      latches: { L2: { latchId: null, latchName: "G", heldOpen: true, manual: true, disabledUntil: null, timezone: null, events: [], recurring: [], raw: {} } },
      raw: {},
    } as never);
    expect(store.get("L2")).toMatchObject({ heldOpen: true, manualHoldOpen: true });
    off();
    store.setManualHoldOpen("L2", false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("door and lock readings", () => {
  const closed = { current: DOOR.CLOSED, target: TARGET.CLOSED, obstructed: false };
  const open = { current: DOOR.OPEN, target: TARGET.OPEN, obstructed: false };

  it("maps settled statuses", () => {
    expect(doorReadingFor("Fully Closed", open)).toEqual(closed);
    expect(doorReadingFor("Not Closed", closed)).toEqual(open);
  });

  it("infers direction for Moving from the previous reading", () => {
    expect(doorReadingFor("Moving", closed)?.current).toBe(DOOR.OPENING);
    expect(doorReadingFor("Moving", open)?.current).toBe(DOOR.CLOSING);
  });

  it("malfunction flags an obstruction and keeps the position", () => {
    expect(doorReadingFor("Malfunction", open)).toEqual({ ...open, obstructed: true });
  });

  it("never invents a position for unknown statuses", () => {
    for (const s of ["Unknown", "Failed to Get Status", "Upgrading", "Synchronizing", null]) {
      expect(doorReadingFor(s, open)).toBeNull();
    }
  });

  it("lock states", () => {
    expect(lockStateFor("Locked")).toBe(LOCK.SECURED);
    expect(lockStateFor("Unlocked")).toBe(LOCK.UNSECURED);
    expect(lockStateFor("Malfunction")).toBe(LOCK.JAMMED);
    expect(lockStateFor("Unknown")).toBe(LOCK.UNKNOWN);
  });
});

describe("inventory", () => {
  const key = (id: string, latches: Array<[string, string]>, extra: object = {}) => ({
    id, name: `Key ${id}`, home: null, disabled: false, hidden: false, pending: false, parentName: null,
    latches: latches.map(([lid, name]) => ({ id: lid, name, offline: false, location: null, heldOpen: false, raw: {} })),
    raw: {}, ...extra,
  });

  it("member: skips disabled/pending keys and dedupes latches", () => {
    const specs = memberInventory([
      key("k1", [["L1", "Front"], ["L2", "Back"]]),
      key("k2", [["L1", "Front again"]]),
      key("k3", [["L3", "Pool"]], { disabled: true }),
      key("k4", [["L4", "Garage"]], { pending: true }),
    ] as never);
    expect(specs).toEqual([
      { latchId: "L1", name: "Front", kind: "momentary", keyId: "k1" },
      { latchId: "L2", name: "Back", kind: "momentary", keyId: "k1" },
    ]);
  });

  it("manager: classifies each latch by its vocabulary", () => {
    const specs = managerInventory({
      latches: [
        latch("L1", "Gate", "Closed", ["Open", "Closed"]),
        latch("L2", "Door", "Locked", ["Locked", "Unlocked"]),
        latch("L3", "Pool", null, []),
      ],
      raw: {},
    } as never);
    expect(specs.map((s) => s.kind)).toEqual(["door", "lock", "momentary"]);
  });

  it("manager without gate_status: everything momentary; exclusions apply", () => {
    const specs = managerInventoryWithoutStatus({
      latches: [{ latchId: "L1", latchName: "A" }, { latchId: "L2", latchName: null }, { latchId: null }],
    } as never);
    expect(specs).toEqual([
      { latchId: "L1", name: "A", kind: "momentary" },
      { latchId: "L2", name: "Nimbio Gate", kind: "momentary" },
    ]);
    expect(excludeLatches(specs, ["L1"]).map((s) => s.latchId)).toEqual(["L2"]);
  });
});

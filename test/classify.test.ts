// Same cases as nimbio-home-assistant/tests/test_const.py — the two
// integrations must classify a latch identically.
import { describe, expect, it } from "vitest";
import { classifyLatch, statusIsClosed, statusIsMoving, statusIsProblem } from "../src/classify.js";

const p = (...labels: string[]) => labels.map((status) => ({ status }));

describe("classifyLatch", () => {
  it("lock vocabulary wins", () => {
    expect(classifyLatch(p("Locked", "Unlocked"))).toBe("lock");
    // Mixed vocab with lock labels still reads as a lock.
    expect(classifyLatch(p("Locked", "Open"))).toBe("lock");
  });

  it("open/closed vocabulary is a sensed door", () => {
    expect(classifyLatch(p("Open", "Closed"))).toBe("door");
    expect(classifyLatch(p("Fully Open", "Fully Closed", "Moving"))).toBe("door");
    expect(classifyLatch(p("Not Open", "Not Closed"))).toBe("door");
  });

  it("no sensing is a momentary opener", () => {
    expect(classifyLatch([])).toBe("momentary");
    expect(classifyLatch(null)).toBe("momentary");
    // Only labels that don't imply a position.
    expect(classifyLatch(p("Malfunction", "No Malfunction"))).toBe("momentary");
  });
});

describe("status mapping", () => {
  it("binary open/closed", () => {
    expect(statusIsClosed("Closed")).toBe(true);
    expect(statusIsClosed("Fully Closed")).toBe(true);
    expect(statusIsClosed("Not Open")).toBe(true);
    expect(statusIsClosed("Locked")).toBe(true);
    expect(statusIsClosed("Open")).toBe(false);
    expect(statusIsClosed("Fully Open")).toBe(false);
    expect(statusIsClosed("Not Closed")).toBe(false);
    // Transitional / diagnostic labels are unknown, never a phantom position.
    expect(statusIsClosed("Unknown")).toBeNull();
    expect(statusIsClosed("Failed to Get Status")).toBeNull();
    expect(statusIsClosed("Upgrading")).toBeNull();
    expect(statusIsClosed(null)).toBeNull();
  });

  it("moving and problem", () => {
    expect(statusIsMoving("Moving")).toBe(true);
    expect(statusIsMoving("Not Moving")).toBe(false);
    expect(statusIsProblem("Malfunction")).toBe(true);
    expect(statusIsProblem("No Malfunction")).toBe(false);
  });
});

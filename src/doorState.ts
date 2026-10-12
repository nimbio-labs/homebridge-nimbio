import { statusIsClosed, statusIsMoving, statusIsProblem } from "./classify.js";

/**
 * HAP values. Fixed by the HomeKit spec, mirrored here so the mapping below is
 * a pure function testable without a HAP runtime.
 */
export const DOOR = { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 } as const;
export const TARGET = { OPEN: 0, CLOSED: 1 } as const;
export const LOCK = { UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 } as const;

export interface DoorReading {
  current: number;
  target: number;
  obstructed: boolean;
}

/**
 * Next garage-door reading for a sensed gate, or null to keep the previous one.
 *
 * Unknown / Failed to Get Status / Upgrading / Synchronizing return null:
 * HomeKit has no "unknown" door state, and showing a made-up open or closed
 * would be worse than showing the last real one.
 */
export function doorReadingFor(status: string | null, prev: DoorReading): DoorReading | null {
  if (statusIsProblem(status)) return { ...prev, obstructed: true };
  if (statusIsMoving(status)) {
    // Direction is inferred from where it was: from open (or already closing)
    // it is closing, otherwise it is opening.
    const closing = prev.current === DOOR.OPEN || prev.current === DOOR.CLOSING;
    return closing
      ? { current: DOOR.CLOSING, target: TARGET.CLOSED, obstructed: false }
      : { current: DOOR.OPENING, target: TARGET.OPEN, obstructed: false };
  }
  const closed = statusIsClosed(status);
  if (closed === true) return { current: DOOR.CLOSED, target: TARGET.CLOSED, obstructed: false };
  if (closed === false) return { current: DOOR.OPEN, target: TARGET.OPEN, obstructed: false };
  return null;
}

/** Lock reading for a Locked/Unlocked latch. Unknown labels read as UNKNOWN. */
export function lockStateFor(status: string | null): number {
  if (statusIsProblem(status)) return LOCK.JAMMED;
  const closed = statusIsClosed(status);
  if (closed === true) return LOCK.SECURED;
  if (closed === false) return LOCK.UNSECURED;
  return LOCK.UNKNOWN;
}

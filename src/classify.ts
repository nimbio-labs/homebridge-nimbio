/**
 * Latch classification and status mapping.
 *
 * A straight port of `custom_components/nimbio/const.py` in
 * nimbio-home-assistant. The two integrations must agree on what a latch *is*
 * — test/classify.test.ts carries the same cases as HA's tests/test_const.py,
 * so a change to either vocabulary shows up as a failing test in the other.
 *
 * The status vocabulary is configured per latch by the community, so the
 * accessory type follows it rather than a hardcoded per-device guess.
 */

export type LatchClass = "lock" | "door" | "momentary";

const LOCK_VOCAB = new Set(["locked", "unlocked"]);
const DOOR_VOCAB = new Set([
  "open", "not open", "closed", "not closed",
  "fully open", "fully closed", "moving", "not moving",
]);

// Sensed labels mapped to a binary open/closed reading. Anything else
// (Unknown / Failed to Get Status / Upgrading / Synchronizing / Malfunction)
// reads as unknown — never a phantom position.
const CLOSED_STATUSES = new Set(["closed", "fully closed", "not open", "locked", "not moving"]);
const OPEN_STATUSES = new Set(["open", "fully open", "not closed", "unlocked"]);
const MOVING_STATUSES = new Set(["moving"]);
const PROBLEM_STATUSES = new Set(["malfunction"]);

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Pick the accessory class for a latch from its configured vocabulary.
 * Locked/Unlocked → lock; any open/closed family → sensed door; no sensing
 * (or only labels that don't imply a position) → momentary opener.
 */
export function classifyLatch(
  possibleStatuses: ReadonlyArray<{ status: string | null }> | null | undefined,
): LatchClass {
  const labels = new Set((possibleStatuses ?? []).map((p) => norm(p.status)).filter(Boolean));
  if ([...labels].some((l) => LOCK_VOCAB.has(l))) return "lock";
  if ([...labels].some((l) => DOOR_VOCAB.has(l))) return "door";
  return "momentary";
}

/** true = closed, false = open, null = unknown. */
export function statusIsClosed(status: string | null | undefined): boolean | null {
  const s = norm(status);
  if (!s) return null;
  if (CLOSED_STATUSES.has(s)) return true;
  if (OPEN_STATUSES.has(s)) return false;
  return null;
}

export function statusIsMoving(status: string | null | undefined): boolean {
  return MOVING_STATUSES.has(norm(status));
}

export function statusIsProblem(status: string | null | undefined): boolean {
  return PROBLEM_STATUSES.has(norm(status));
}

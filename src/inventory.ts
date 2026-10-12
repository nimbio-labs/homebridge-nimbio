import type { AccountKey, CommunityInfo, GateStatus } from "@nimbio/community-api";
import { classifyLatch, type LatchClass } from "./classify.js";

/** One gate the plugin will expose. */
export interface GateSpec {
  latchId: string;
  name: string;
  kind: LatchClass;
  /** Member keys open through a specific Nimbio key; community keys don't need one. */
  keyId?: string;
}

/**
 * Member inventory: every latch on every usable key the account holds.
 *
 * Disabled and pending keys are skipped — they cannot open. A latch reachable
 * through two keys appears once (the first key wins), since the accessory is
 * identified by latch.
 */
export function memberInventory(keys: readonly AccountKey[]): GateSpec[] {
  const seen = new Map<string, GateSpec>();
  for (const key of keys) {
    if (!key.id || key.disabled || key.pending) continue;
    for (const latch of key.latches) {
      if (!latch.id || seen.has(latch.id)) continue;
      seen.set(latch.id, {
        latchId: latch.id,
        name: latch.name ?? key.name ?? "Nimbio Gate",
        kind: "momentary",
        keyId: key.id,
      });
    }
  }
  return [...seen.values()];
}

/** Manager inventory from gate status: the accessory type follows each latch's vocabulary. */
export function managerInventory(status: GateStatus): GateSpec[] {
  return status.latches.flatMap((l) =>
    l.latchId
      ? [{ latchId: l.latchId, name: l.latchName ?? "Nimbio Gate", kind: classifyLatch(l.possibleStatuses) }]
      : [],
  );
}

/**
 * Manager inventory for a community key without `gate_status`: no sensed
 * state to show, so every latch is a momentary opener.
 */
export function managerInventoryWithoutStatus(info: CommunityInfo): GateSpec[] {
  return info.latches.flatMap((l) =>
    l.latchId ? [{ latchId: l.latchId, name: l.latchName ?? "Nimbio Gate", kind: "momentary" as const }] : [],
  );
}

export function excludeLatches(specs: GateSpec[], excluded: readonly string[]): GateSpec[] {
  if (excluded.length === 0) return specs;
  const drop = new Set(excluded);
  return specs.filter((s) => !drop.has(s.latchId));
}

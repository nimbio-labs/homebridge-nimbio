import type { PlatformConfig } from "homebridge";

export type LiveUpdates = "stream" | "polling";

export interface NimbioConfig {
  name: string;
  apiKey: string;
  environment: "prod" | "dev";
  liveUpdates: LiveUpdates;
  pollSeconds: number;
  momentaryResetSeconds: number;
  holdOpenSwitches: boolean;
  excludeLatchIds: string[];
}

export const DEFAULTS = {
  pollSeconds: 60,
  momentaryResetSeconds: 5,
} as const;

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * Normalise the raw platform block. Returns null when no API key is set — the
 * plugin must not start until it is configured (a Homebridge Verified rule).
 */
export function parseConfig(raw: PlatformConfig): NimbioConfig | null {
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (!apiKey) return null;
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : "Nimbio",
    apiKey,
    environment: raw.environment === "dev" ? "dev" : "prod",
    liveUpdates: raw.liveUpdates === "polling" ? "polling" : "stream",
    // Floor of 30s: the per-minute limit is 60 and a poll cycle is two reads.
    pollSeconds: clamp(raw.pollSeconds, 30, 3600, DEFAULTS.pollSeconds),
    momentaryResetSeconds: clamp(raw.momentaryResetSeconds, 1, 300, DEFAULTS.momentaryResetSeconds),
    holdOpenSwitches: raw.holdOpenSwitches !== false,
    excludeLatchIds: Array.isArray(raw.excludeLatchIds)
      ? raw.excludeLatchIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [],
  };
}

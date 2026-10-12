import type { Me } from "@nimbio/community-api";

/**
 * What the connected key is allowed to show.
 *
 * Decided once at startup from `me()`. The *mode* follows the key type — a
 * community key belongs to a community manager, anything else is a member's
 * personal key — and each feature is then gated on its own capability, never
 * on the type alone: a community key whose manager was not granted hold-open
 * access gets no hold-open switches, exactly as in the Home Assistant
 * integration.
 *
 * This is about the key, not the person. A community manager who pastes their
 * personal (member) key gets the member experience.
 */
export type Mode = "member" | "manager";

export interface Session {
  mode: Mode;
  capabilities: string[];
  /** A `nimbio_test_…` key: opens are simulated server-side. */
  testMode: boolean;
  /** Live sensed gate state (manager keys with `gate_status`). */
  gateStatus: boolean;
  /** Manual hold-open switches (manager keys with `hold_opens`). */
  holdOpens: boolean;
}

export function resolveSession(me: Me): Session {
  const capabilities = [...(me.key.capabilities ?? [])];
  const mode: Mode = me.key.type === "community" ? "manager" : "member";
  const has = (cap: string) => capabilities.includes(cap);
  return {
    mode,
    capabilities,
    testMode: me.key.mode === "test",
    gateStatus: mode === "manager" && has("gate_status"),
    holdOpens: mode === "manager" && has("hold_opens"),
  };
}

export function describeSession(s: Session): string {
  const test = s.testMode ? " (test key — opens are simulated)" : "";
  if (s.mode === "member") {
    return `Connected with a member key${test}: gates are open-only. ` +
      "Use a community API key from the admin portal for live status and hold-opens.";
  }
  const parts = ["opens"];
  if (s.gateStatus) parts.push("live gate status");
  if (s.holdOpens) parts.push("hold-opens");
  return `Connected with a community manager key${test}: ${parts.join(", ")}.`;
}

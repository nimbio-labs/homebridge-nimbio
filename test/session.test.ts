import { describe, expect, it } from "vitest";
import { describeSession, resolveSession } from "../src/session.js";
import { parseConfig } from "../src/config.js";
import { me } from "./helpers.js";

describe("resolveSession", () => {
  it("community key → manager with status and hold-opens", () => {
    const s = resolveSession(me("community", ["open", "gate_status", "hold_opens", "webhooks"]) as never);
    expect(s).toMatchObject({ mode: "manager", gateStatus: true, holdOpens: true, testMode: true });
    expect(describeSession(s)).toContain("live gate status, hold-opens");
  });

  it("account key → member, open-only, whatever capabilities it claims", () => {
    const s = resolveSession(me("account", ["open", "gate_status", "hold_opens"], "live") as never);
    expect(s).toMatchObject({ mode: "member", gateStatus: false, holdOpens: false, testMode: false });
    expect(describeSession(s)).toContain("open-only");
  });

  it("community key without hold_opens gets no hold-opens", () => {
    const s = resolveSession(me("community", ["open", "gate_status"]) as never);
    expect(s).toMatchObject({ mode: "manager", gateStatus: true, holdOpens: false });
    expect(describeSession(s)).not.toContain("hold-opens");
  });

  it("community key without gate_status is still a manager, just unsensed", () => {
    const s = resolveSession(me("community", ["open"]) as never);
    expect(s).toMatchObject({ mode: "manager", gateStatus: false, holdOpens: false });
  });

  it("a missing key type is treated as a member key", () => {
    const m = me("account", ["open"]);
    (m.key as { type: string | null }).type = null;
    expect(resolveSession(m as never).mode).toBe("member");
  });
});

describe("parseConfig", () => {
  it("returns null without an API key", () => {
    expect(parseConfig({ platform: "NimbioGates" })).toBeNull();
    expect(parseConfig({ platform: "NimbioGates", apiKey: "   " })).toBeNull();
  });

  it("applies defaults and clamps", () => {
    const c = parseConfig({ platform: "NimbioGates", apiKey: " k ", pollSeconds: 5, momentaryResetSeconds: "abc" });
    expect(c).toMatchObject({
      apiKey: "k", environment: "prod", liveUpdates: "stream", pollSeconds: 30,
      momentaryResetSeconds: 5, holdOpenSwitches: true, excludeLatchIds: [],
    });
  });

  it("honours explicit options", () => {
    const c = parseConfig({
      platform: "NimbioGates", apiKey: "k", environment: "dev", liveUpdates: "polling",
      pollSeconds: 120, holdOpenSwitches: false, excludeLatchIds: ["a", 3, ""],
    });
    expect(c).toMatchObject({
      environment: "dev", liveUpdates: "polling", pollSeconds: 120, holdOpenSwitches: false, excludeLatchIds: ["a"],
    });
  });
});

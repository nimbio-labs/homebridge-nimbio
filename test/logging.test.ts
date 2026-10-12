// The API key must never reach the log: users paste Homebridge logs into
// public GitHub issues. dev-smoke.sh checks this against a real Homebridge;
// this pins it in the unit suite, through every failure path that logs.
import { AuthenticationError, GateNotOpenedError, PermissionDeniedError, RateLimitError } from "@nimbio/community-api";
import * as hap from "@homebridge/hap-nodejs";
import { describe, expect, it, vi } from "vitest";
import { NimbioPlatform } from "../src/platform.js";
import { PLATFORM_NAME } from "../src/settings.js";
import { FakeAccessory, flush, latch, makeApi, makeLog, makeStream, me } from "./helpers.js";

const KEY = "nimbio_live_DO_NOT_LOG_7f3a9c2e1b";

function allLogged(log: ReturnType<typeof makeLog>): string {
  const calls = [log, log.info, log.warn, log.error, log.debug, log.success, log.log] as unknown as Array<{ mock: { calls: unknown[][] } }>;
  return calls.flatMap((f) => f.mock.calls.flat()).map(String).join("\n");
}

describe("API key never logged", () => {
  it("manager key through open, hold-open, stream and refresh failures", async () => {
    const stream = makeStream();
    const client = {
      me: vi.fn().mockResolvedValue(me("community", ["open", "gate_status", "hold_opens"], "live")),
      account: { keys: vi.fn(), open: vi.fn() },
      community: {
        gateStatus: vi.fn()
          .mockResolvedValueOnce({ latches: [latch("L1", "Front", "Closed", ["Open", "Closed"])], raw: {} })
          .mockRejectedValue(new RateLimitError("slow down", { status: 429, code: "rate_limited" })),
        holdOpens: vi.fn().mockRejectedValue(new PermissionDeniedError("no", { status: 403, code: "api_access_revoked" })),
        info: vi.fn(),
        open: vi.fn().mockRejectedValue(new GateNotOpenedError("no confirm", { status: 504, code: "gate_not_opened" })),
        setHoldOpen: vi.fn().mockRejectedValue(new Error("boom")),
        streamEvents: stream.streamEvents,
      },
    };
    const api = makeApi();
    const log = makeLog();
    const platform = new NimbioPlatform(log, { platform: PLATFORM_NAME, apiKey: KEY }, api, {
      createClient: () => client as never,
    });
    api.emit("didFinishLaunching");
    await flush();
    await flush();
    const registered = api.registerPlatformAccessories.mock.calls[0]![2] as FakeAccessory[];
    const gate = registered.find((a) => a.getService(hap.Service.GarageDoorOpener))!;
    const hold = registered.find((a) => a.getService(hap.Service.Switch))!;
    await gate.getService(hap.Service.GarageDoorOpener)!.getCharacteristic(hap.Characteristic.TargetDoorState)
      .handleSetRequest(0);
    await hold.getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On)
      .handleSetRequest(true).catch(() => undefined);
    stream.fail(new RateLimitError("limit", { status: 429, code: "stream_limit" }));
    await flush();
    await flush();
    platform.stop();

    const text = allLogged(log);
    expect(text).toContain("open failed"); // the paths really ran
    expect(text).toContain("hold-open on failed");
    expect(text).toContain("Event stream unavailable");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(12)); // not even the secret part
  });

  it("rejected key", async () => {
    const client = { me: vi.fn().mockRejectedValue(new AuthenticationError(`bad key`, { status: 401, code: "invalid_api_key" })) };
    const api = makeApi();
    const log = makeLog();
    new NimbioPlatform(log, { platform: PLATFORM_NAME, apiKey: KEY }, api, { createClient: () => client as never });
    api.emit("didFinishLaunching");
    await flush();
    expect(allLogged(log)).toContain("rejected the API key");
    expect(allLogged(log)).not.toContain(KEY);
  });
});

import { APIConnectionError, AuthenticationError } from "@nimbio/community-api";
import * as hap from "@homebridge/hap-nodejs";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { NimbioPlatform } from "../src/platform.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "../src/settings.js";
import { VERSION } from "../src/version.js";
import { FakeAccessory, flush, latch, makeApi, makeLog, makeStream, me } from "./helpers.js";

function makeClient(type: "account" | "community", caps: string[]) {
  const stream = makeStream();
  return {
    stream,
    me: vi.fn().mockResolvedValue(me(type, caps)),
    account: {
      keys: vi.fn().mockResolvedValue([
        {
          id: "k1", name: "Home", disabled: false, pending: false, hidden: false, home: null, parentName: null, raw: {},
          latches: [
            { id: "L1", name: "Front Gate", offline: false, location: null, heldOpen: false, raw: {} },
            { id: "L2", name: "Pool", offline: false, location: null, heldOpen: false, raw: {} },
          ],
        },
      ]),
      open: vi.fn(),
    },
    community: {
      gateStatus: vi.fn().mockResolvedValue({
        latches: [
          latch("L1", "Front Gate", "Closed", ["Open", "Closed"]),
          latch("L2", "Lobby Door", "Locked", ["Locked", "Unlocked"]),
          latch("L3", "Pool", null, []),
        ],
        raw: {},
      }),
      info: vi.fn().mockResolvedValue({ latches: [{ latchId: "L9", latchName: "Only" }] }),
      holdOpens: vi.fn().mockResolvedValue({ latches: {}, raw: {} }),
      streamEvents: stream.streamEvents,
      open: vi.fn(),
      setHoldOpen: vi.fn(),
    },
  };
}

async function boot(client: ReturnType<typeof makeClient>, config: Record<string, unknown> = {}, cached: FakeAccessory[] = []) {
  const api = makeApi();
  const log = makeLog();
  const platform = new NimbioPlatform(log, { platform: PLATFORM_NAME, apiKey: "nimbio_test_x", ...config }, api, {
    createClient: () => client as never,
    retryMs: 10,
  });
  for (const a of cached) platform.configureAccessory(a as never);
  api.emit("didFinishLaunching");
  await flush();
  await flush();
  const registered = (api.registerPlatformAccessories.mock.calls[0]?.[2] ?? []) as FakeAccessory[];
  return { api, log, platform, registered };
}

const services = (accs: FakeAccessory[]) =>
  accs.map((a) => a.services.filter((s) => !(s instanceof hap.Service.AccessoryInformation)).map((s) => s.constructor.name)[0]);

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

describe("NimbioPlatform", () => {
  it("registers the platform under its alias", () => {
    const api = makeApi();
    plugin(api);
    expect(api.registerPlatform).toHaveBeenCalledWith(PLATFORM_NAME, NimbioPlatform);
  });

  it("does nothing without an API key", () => {
    const api = makeApi();
    const log = makeLog();
    new NimbioPlatform(log, { platform: PLATFORM_NAME }, api);
    expect(api.listenerCount("didFinishLaunching")).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("No API key"));
  });

  it("identifies itself to the API as homebridge/<version>", async () => {
    const client = makeClient("account", ["open"]);
    const createClient = vi.fn(() => client as never);
    const api = makeApi();
    const platform = new NimbioPlatform(makeLog(), { platform: PLATFORM_NAME, apiKey: "nimbio_test_x" }, api, { createClient, retryMs: 10 });
    stop = () => platform.stop();
    api.emit("didFinishLaunching");
    await flush();
    expect(createClient).toHaveBeenCalledWith("nimbio_test_x", expect.objectContaining({
      defaultHeaders: { "X-Nimbio-Integration": `homebridge/${VERSION}` },
    }));
  });

  it("member key: open-only garage doors, no hold-opens, no stream, no status reads", async () => {
    const client = makeClient("account", ["open"]);
    const { api, registered, platform, log } = await boot(client);
    stop = () => platform.stop();
    expect(registered.map((a) => a.displayName)).toEqual(["Front Gate", "Pool"]);
    expect(services(registered)).toEqual(["GarageDoorOpener", "GarageDoorOpener"]);
    expect(api.registerPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, expect.any(Array));
    expect(client.community.gateStatus).not.toHaveBeenCalled();
    expect(client.community.holdOpens).not.toHaveBeenCalled();
    expect(client.community.streamEvents).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("open-only"));
  });

  it("manager key: door, lock and momentary gates plus hold-open switches, and the stream", async () => {
    const client = makeClient("community", ["open", "gate_status", "hold_opens"]);
    const { registered, platform } = await boot(client);
    stop = () => platform.stop();
    expect(registered.map((a) => a.displayName)).toEqual([
      "Front Gate", "Front Gate Hold Open", "Lobby Door", "Lobby Door Hold Open", "Pool", "Pool Hold Open",
    ]);
    expect(services(registered)).toEqual([
      "GarageDoorOpener", "Switch", "LockMechanism", "Switch", "GarageDoorOpener", "Switch",
    ]);
    expect(registered[2]?.category).toBe(hap.Categories.DOOR_LOCK);
    expect(client.community.streamEvents).toHaveBeenCalledTimes(1);
  });

  it("manager key without hold_opens: no switches; holdOpenSwitches=false also hides them", async () => {
    const noCap = await boot(makeClient("community", ["open", "gate_status"]));
    noCap.platform.stop();
    expect(noCap.registered.every((a) => !a.displayName.endsWith("Hold Open"))).toBe(true);

    const optedOut = await boot(makeClient("community", ["open", "gate_status", "hold_opens"]), { holdOpenSwitches: false });
    optedOut.platform.stop();
    expect(optedOut.registered).toHaveLength(3);
  });

  it("manager key without gate_status: momentary gates from community info, no stream", async () => {
    const client = makeClient("community", ["open"]);
    const { registered, platform } = await boot(client);
    platform.stop();
    expect(registered.map((a) => a.displayName)).toEqual(["Only"]);
    expect(client.community.info).toHaveBeenCalled();
    expect(client.community.streamEvents).not.toHaveBeenCalled();
  });

  it("reuses cached accessories, removes stale ones, honours excludeLatchIds", async () => {
    const keepUuid = hap.uuid.generate("nimbio:gate:L1");
    const cachedKeep = new FakeAccessory("Front Gate", keepUuid);
    const cachedStale = new FakeAccessory("Old", hap.uuid.generate("nimbio:gate:GONE"));
    const { api, registered, platform } = await boot(makeClient("account", ["open"]), { excludeLatchIds: ["L2"] }, [
      cachedKeep, cachedStale,
    ]);
    platform.stop();
    expect(registered).toHaveLength(0);
    expect(api.updatePlatformAccessories).toHaveBeenCalledWith([cachedKeep]);
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [cachedStale]);
    expect(cachedKeep.context).toEqual({ latchId: "L1", role: "gate" });
  });

  it("a rejected key registers nothing and keeps the cache", async () => {
    const client = makeClient("account", ["open"]);
    client.me.mockRejectedValue(new AuthenticationError("bad", { status: 401, code: "invalid_api_key" }));
    const cached = new FakeAccessory("Front Gate", hap.uuid.generate("nimbio:gate:L1"));
    const { api, log } = await boot(client, {}, [cached]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("rejected the API key"));
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  it("retries startup after a network failure; shutdown cancels it", async () => {
    const client = makeClient("account", ["open"]);
    client.me.mockRejectedValueOnce(new APIConnectionError("offline"));
    const { api, log } = await boot(client);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not reach Nimbio"));
    await new Promise((r) => setTimeout(r, 30));
    await flush();
    expect(client.me).toHaveBeenCalledTimes(2);
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    api.emit("shutdown");
  });
});

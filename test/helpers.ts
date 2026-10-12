import { EventEmitter } from "node:events";
import * as hap from "@homebridge/hap-nodejs";
import type { API, Logging, PlatformConfig } from "homebridge";
import { vi } from "vitest";
import type { NimbioConfig } from "../src/config.js";
import { parseConfig } from "../src/config.js";

/**
 * Stand-in for Homebridge's PlatformAccessory: a real HAP Accessory plus the
 * `context` bag. Homebridge does not export the class at runtime.
 */
export class FakeAccessory extends hap.Accessory {
  context: Record<string, unknown> = {};
  constructor(displayName: string, uuid: string, category?: hap.Categories) {
    super(displayName, uuid);
    if (category !== undefined) this.category = category;
  }
}

export type FakeApi = API & EventEmitter & {
  registerPlatformAccessories: ReturnType<typeof vi.fn>;
  updatePlatformAccessories: ReturnType<typeof vi.fn>;
  unregisterPlatformAccessories: ReturnType<typeof vi.fn>;
};

export function makeApi(): FakeApi {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    hap,
    platformAccessory: FakeAccessory,
    registerPlatform: vi.fn(),
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  }) as unknown as FakeApi;
}

export function makeLog(): Logging & Record<"info" | "warn" | "error" | "debug", ReturnType<typeof vi.fn>> {
  const fn = Object.assign(vi.fn(), {
    prefix: "Nimbio",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    log: vi.fn(),
  });
  return fn as never;
}

export function makeConfig(over: Partial<PlatformConfig> = {}): NimbioConfig {
  const c = parseConfig({ platform: "NimbioGates", apiKey: "nimbio_test_abc", ...over });
  if (!c) throw new Error("config");
  return c;
}

/** `me()` payload as the SDK parses it. */
export function me(type: "account" | "community", capabilities: string[], mode: "test" | "live" = "test") {
  return {
    accountId: "acct-1",
    key: {
      apiKeyId: "k1", prefix: "nimbio_test_abc", name: "HB", mode, type, communityId: type === "community" ? "c1" : null,
      capabilities, lastUsedDatetime: null, minuteLimit: 60, minuteCount: 0, monthLimit: 1000, monthCount: 0, raw: {},
    },
    raw: {},
  };
}

export const latch = (latchId: string, latchName: string, status: string | null, vocab: string[]) => ({
  latchId, latchName, status, offline: false, message: null,
  possibleStatuses: vocab.map((s) => ({ status: s, transient: s === "Moving", raw: {} })),
  raw: {},
});

export const openResult = (simulated = true) => ({
  result: simulated ? "simulated" : "opened", requestId: "r1", keyLogId: 1, latchId: "L1",
  opened: !simulated, simulated, raw: {},
});

/**
 * Controllable live stream: `push()` delivers a message, `fail()` makes the
 * generator throw, and aborting the signal ends it the way the SDK does.
 */
export function makeStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let error: unknown;
  const calls: Array<{ events?: readonly string[] }> = [];
  const streamEvents = vi.fn(async function* (opts: { events?: readonly string[]; signal?: AbortSignal }) {
    calls.push(opts);
    for (;;) {
      if (opts.signal?.aborted) return;
      if (error) { const e = error; error = undefined; throw e; }
      if (queue.length) { yield queue.shift(); continue; }
      await new Promise<void>((r) => {
        wake = r;
        opts.signal?.addEventListener("abort", () => r(), { once: true });
      });
    }
  });
  return {
    streamEvents,
    calls,
    push(msg: unknown) { queue.push(msg); wake?.(); },
    fail(e: unknown) { error = e; wake?.(); },
  };
}

/** Let pending promise callbacks and setImmediate run. */
export const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * A stream event in the shape the SDK really yields: `data` is the whole
 * webhook envelope and `payload` is its inner `data`. (Getting this wrong in
 * tests is how the plugin once read the envelope and ignored every event.)
 */
export function streamEvent(type: string, payload: Record<string, unknown>, id = "1") {
  return {
    kind: "event" as const,
    id,
    type,
    data: { event: type, id: `evt_${id}`, community_id: "c1", occurred_at: "2026-10-12T00:00:00Z", data: payload },
    payload,
  };
}

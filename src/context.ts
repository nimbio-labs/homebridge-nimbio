import type { NimbioClient } from "@nimbio/community-api";
import type { API, Logging, PlatformAccessory } from "homebridge";
import type { NimbioConfig } from "./config.js";
import type { GateSpec } from "./inventory.js";
import type { Opener } from "./opener.js";
import type { StateStore } from "./state.js";
import { VERSION } from "./version.js";

/** What every accessory handler needs from the platform. */
export interface PluginContext {
  api: API;
  log: Logging;
  config: NimbioConfig;
  client: NimbioClient;
  opener: Opener;
  store: StateStore;
}

/** Persisted on the accessory across restarts. */
export interface AccessoryContext {
  latchId: string;
  role: "gate" | "lock" | "holdOpen";
}

export interface AccessoryHandler {
  dispose(): void;
}

export function setAccessoryInfo(ctx: PluginContext, accessory: PlatformAccessory, gate: GateSpec, model: string): void {
  const { Service, Characteristic } = ctx.api.hap;
  const info = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Manufacturer, "Nimbio")
    .setCharacteristic(Characteristic.Model, model)
    .setCharacteristic(Characteristic.SerialNumber, gate.latchId)
    .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
}

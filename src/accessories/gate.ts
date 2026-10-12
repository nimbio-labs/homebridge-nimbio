import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { type AccessoryHandler, type PluginContext, setAccessoryInfo } from "../context.js";
import { DOOR, type DoorReading, TARGET, doorReadingFor } from "../doorState.js";
import type { GateSpec } from "../inventory.js";

/**
 * How long a sensed gate may sit in "Opening" after a confirmed open before
 * the plugin gives up waiting for a status event and falls back to the last
 * real reading. Gates over cellular take a while; this is generous on purpose.
 */
export const SENSED_SETTLE_MS = 60_000;

/**
 * A gate exposed as a HomeKit Garage Door Opener.
 *
 * Garage door rather than a plain switch because HomeKit treats it as a secure
 * device: it needs an unlocked iPhone, Siri asks for confirmation, and it is
 * offered in CarPlay on approach.
 *
 * Two flavours:
 * - **momentary** (member keys, and latches with no sense line): rests Closed;
 *   an open shows Opening → Open, then Closed again after
 *   `momentaryResetSeconds`. Nothing is sensed, so nothing is polled.
 * - **sensed** (community keys, open/closed vocabulary): the reading follows
 *   live status from the state store.
 *
 * Reads never throw. A box going offline does not turn the gate into
 * "No Response" — the open stays pressable, matching the HA integration.
 */
export class GateAccessory implements AccessoryHandler {
  private readonly service: Service;
  private reading: DoorReading = { current: DOOR.CLOSED, target: TARGET.CLOSED, obstructed: false };
  private lastStatus: string | null = null;
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly ctx: PluginContext,
    accessory: PlatformAccessory,
    private readonly gate: GateSpec,
  ) {
    const { Service, Characteristic } = ctx.api.hap;
    setAccessoryInfo(ctx, accessory, gate, this.sensed ? "Gate (sensed)" : "Gate");
    this.service =
      accessory.getService(Service.GarageDoorOpener) ?? accessory.addService(Service.GarageDoorOpener, gate.name);

    this.service.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => this.reading.current);
    this.service
      .getCharacteristic(Characteristic.TargetDoorState)
      .onGet(() => this.reading.target)
      .onSet((v) => this.onSetTarget(v));
    this.service.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => this.reading.obstructed);

    if (this.sensed) {
      this.unsubscribe = ctx.store.subscribe(gate.latchId, (s) => this.onStatus(s.status));
      const known = ctx.store.get(gate.latchId);
      if (known) this.onStatus(known.status);
    }
    this.push();
  }

  get sensed(): boolean {
    return this.gate.kind === "door";
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.unsubscribe?.();
  }

  private onSetTarget(value: CharacteristicValue): void {
    if (value === TARGET.OPEN) {
      if (this.busy) return;
      this.busy = true;
      clearTimeout(this.timer);
      this.set({ current: DOOR.OPENING, target: TARGET.OPEN });
      // Answer HomeKit now: the open waits for the box to confirm, which can
      // take many seconds over cellular, and a slow set handler stalls the bridge.
      void this.runOpen();
      return;
    }
    // Close requested. Nimbio gates close on their own; there is no close command.
    if (this.sensed) {
      this.ctx.log.info(`${this.gate.name}: Nimbio gates close on their own — no close command sent.`);
      setImmediate(() => this.set({ target: this.reading.current === DOOR.CLOSED ? TARGET.CLOSED : TARGET.OPEN }));
    } else {
      // Momentary: the open/closed picture is only a timer, so just settle it now.
      clearTimeout(this.timer);
      this.set({ current: DOOR.CLOSED, target: TARGET.CLOSED });
    }
  }

  private async runOpen(): Promise<void> {
    const { HapStatusError, HAPStatus } = this.ctx.api.hap;
    const resetMs = this.ctx.config.momentaryResetSeconds * 1000;
    try {
      await this.ctx.opener.open(this.gate);
      if (this.sensed) {
        // Status events drive the reading from here. If none arrives, fall back
        // to the last real reading rather than sitting in Opening forever.
        this.timer = setTimeout(() => this.settleFromStatus(), SENSED_SETTLE_MS);
      } else {
        this.set({ current: DOOR.OPEN, target: TARGET.OPEN });
        this.timer = setTimeout(() => this.set({ current: DOOR.CLOSED, target: TARGET.CLOSED }), resetMs);
      }
    } catch {
      // Flag the failure in the Home app, then return to the resting picture.
      this.service
        .getCharacteristic(this.ctx.api.hap.Characteristic.CurrentDoorState)
        .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      this.timer = setTimeout(() => this.settleFromStatus(), resetMs);
    } finally {
      this.busy = false;
    }
  }

  private onStatus(status: string | null): void {
    this.lastStatus = status;
    const next = doorReadingFor(status, this.reading);
    if (!next) {
      this.ctx.log.debug(`${this.gate.name}: status "${status ?? "none"}" is not a position; keeping last reading`);
      return;
    }
    // A settled reading ends any wait started by an open.
    if (next.current === DOOR.OPEN || next.current === DOOR.CLOSED) clearTimeout(this.timer);
    this.set(next);
  }

  private settleFromStatus(): void {
    const next = this.sensed ? doorReadingFor(this.lastStatus, { ...this.reading, current: DOOR.CLOSED }) : null;
    this.set(next ?? { current: DOOR.CLOSED, target: TARGET.CLOSED });
  }

  private set(patch: Partial<DoorReading>): void {
    this.reading = { ...this.reading, ...patch };
    this.push();
  }

  private push(): void {
    const { Characteristic } = this.ctx.api.hap;
    this.service.updateCharacteristic(Characteristic.CurrentDoorState, this.reading.current);
    this.service.updateCharacteristic(Characteristic.TargetDoorState, this.reading.target);
    this.service.updateCharacteristic(Characteristic.ObstructionDetected, this.reading.obstructed);
  }
}

import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { type AccessoryHandler, type PluginContext, setAccessoryInfo } from "../context.js";
import { statusIsClosed, statusIsProblem } from "../classify.js";
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
        // Status events drive the reading from here. Only wait if it is still
        // in motion: a settled event may already have arrived while the box
        // was confirming the open.
        if (this.inMotion()) this.armSettle();
      } else {
        this.set({ current: DOOR.OPEN, target: TARGET.OPEN });
        this.timer = setTimeout(() => this.set({ current: DOOR.CLOSED, target: TARGET.CLOSED }), resetMs);
      }
    } catch {
      // Flag the failure in the Home app, then return to the resting picture.
      this.service
        .getCharacteristic(this.ctx.api.hap.Characteristic.CurrentDoorState)
        .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      clearTimeout(this.timer);
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
    this.set(next);
    // In motion: wait for the settled status, but not forever (the final event
    // can be lost to a stream drop). Settled: end any such wait.
    if (this.inMotion()) this.armSettle();
    else clearTimeout(this.timer);
  }

  private inMotion(): boolean {
    return this.reading.current === DOOR.OPENING || this.reading.current === DOOR.CLOSING;
  }

  private armSettle(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.settleFromStatus(), SENSED_SETTLE_MS);
  }

  /**
   * Fall back to a *settled* reading. Open only if the last real status says
   * open; anything else — Moving, Malfunction, Unknown — rests at Closed, so the
   * tile can never be left in Opening/Closing with nothing to move it on.
   */
  private settleFromStatus(): void {
    const status = this.sensed ? this.lastStatus : null;
    const open = statusIsClosed(status) === false;
    this.set({
      current: open ? DOOR.OPEN : DOOR.CLOSED,
      target: open ? TARGET.OPEN : TARGET.CLOSED,
      obstructed: statusIsProblem(status),
    });
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

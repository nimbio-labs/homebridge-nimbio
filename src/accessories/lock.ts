import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { type AccessoryHandler, type PluginContext, setAccessoryInfo } from "../context.js";
import { LOCK, lockStateFor } from "../doorState.js";
import type { GateSpec } from "../inventory.js";

/** How long an unlock waits for a status event before snapping the target back. */
export const UNLOCK_SETTLE_MS = 30_000;

/**
 * A latch whose sense line reports Locked/Unlocked, exposed as a Lock.
 *
 * Unlock fires an open. Nimbio has no lock command — latches relock on their
 * own — so a lock request just snaps the target back to the sensed state.
 * Lock is a secure HomeKit device like the garage door: unlocked iPhone and
 * Siri confirmation required.
 */
export class LockAccessory implements AccessoryHandler {
  private readonly service: Service;
  private current: number = LOCK.UNKNOWN;
  private target: number = LOCK.SECURED;
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: PluginContext,
    accessory: PlatformAccessory,
    private readonly gate: GateSpec,
  ) {
    const { Service, Characteristic } = ctx.api.hap;
    setAccessoryInfo(ctx, accessory, gate, "Lock");
    this.service = accessory.getService(Service.LockMechanism) ?? accessory.addService(Service.LockMechanism, gate.name);
    this.service.getCharacteristic(Characteristic.LockCurrentState).onGet(() => this.current);
    this.service
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => this.target)
      .onSet((v) => this.onSetTarget(v));

    this.unsubscribe = ctx.store.subscribe(gate.latchId, (s) => this.onStatus(s.status));
    const known = ctx.store.get(gate.latchId);
    if (known) this.onStatus(known.status);
    this.push();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.unsubscribe();
  }

  private onSetTarget(value: CharacteristicValue): void {
    if (value === LOCK.UNSECURED) {
      if (this.busy) return;
      this.busy = true;
      this.target = LOCK.UNSECURED;
      void this.runOpen();
      return;
    }
    this.ctx.log.info(`${this.gate.name}: Nimbio latches relock on their own — no lock command sent.`);
    setImmediate(() => this.snapTarget());
  }

  private async runOpen(): Promise<void> {
    const { HapStatusError, HAPStatus, Characteristic } = this.ctx.api.hap;
    try {
      await this.ctx.opener.open(this.gate);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.snapTarget(), UNLOCK_SETTLE_MS);
    } catch {
      this.service
        .getCharacteristic(Characteristic.LockCurrentState)
        .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      this.timer = setTimeout(() => this.snapTarget(), this.ctx.config.momentaryResetSeconds * 1000);
    } finally {
      this.busy = false;
    }
  }

  private onStatus(status: string | null): void {
    this.current = lockStateFor(status);
    if (this.current === LOCK.SECURED || this.current === LOCK.UNSECURED) {
      clearTimeout(this.timer);
      this.target = this.current;
    }
    this.push();
  }

  /** Target follows the sensed state; with no reading, rest at Secured. */
  private snapTarget(): void {
    this.target = this.current === LOCK.UNSECURED ? LOCK.UNSECURED : LOCK.SECURED;
    this.push();
  }

  private push(): void {
    const { Characteristic } = this.ctx.api.hap;
    this.service.updateCharacteristic(Characteristic.LockCurrentState, this.current);
    this.service.updateCharacteristic(Characteristic.LockTargetState, this.target);
  }
}

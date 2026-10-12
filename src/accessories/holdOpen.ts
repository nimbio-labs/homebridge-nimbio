import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { type AccessoryHandler, type PluginContext, setAccessoryInfo } from "../context.js";
import { describeError } from "../errors.js";
import type { GateSpec } from "../inventory.js";

/**
 * The manual hold-open flag for one gate, as a Switch (community keys with
 * the `hold_opens` capability only).
 *
 * On reflects the *manual* flag only, as in the HA integration: turning it off
 * does not cancel scheduled or recurring hold-open windows, which are managed
 * in the Nimbio portal.
 */
export class HoldOpenAccessory implements AccessoryHandler {
  private readonly service: Service;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: PluginContext,
    accessory: PlatformAccessory,
    private readonly gate: GateSpec,
  ) {
    const { Service, Characteristic } = ctx.api.hap;
    setAccessoryInfo(ctx, accessory, gate, "Hold Open");
    this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, `${gate.name} Hold Open`);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet((v) => this.onSet(v));
    this.unsubscribe = ctx.store.subscribe(gate.latchId, () => this.push());
    this.push();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private get on(): boolean {
    return this.ctx.store.get(this.gate.latchId)?.manualHoldOpen ?? false;
  }

  private async onSet(value: CharacteristicValue): Promise<void> {
    const want = value === true || value === 1;
    const { HapStatusError, HAPStatus } = this.ctx.api.hap;
    try {
      const res = await this.ctx.client.community.setHoldOpen(this.gate.latchId, want);
      this.ctx.log.info(
        `${this.gate.name}: hold-open ${want ? "on" : "off"}${res.simulated ? " (simulated — test key)" : ""}`,
      );
      this.ctx.store.setManualHoldOpen(this.gate.latchId, want);
    } catch (e) {
      this.ctx.log.error(`${this.gate.name}: hold-open ${want ? "on" : "off"} failed — ${describeError(e)}`);
      setImmediate(() => this.push());
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private push(): void {
    this.service.updateCharacteristic(this.ctx.api.hap.Characteristic.On, this.on);
  }
}

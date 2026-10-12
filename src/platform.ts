import { AuthenticationError, NimbioClient, type ClientOptions } from "@nimbio/community-api";
import type {
  API,
  Categories,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { GateAccessory } from "./accessories/gate.js";
import { HoldOpenAccessory } from "./accessories/holdOpen.js";
import { LockAccessory } from "./accessories/lock.js";
import { type NimbioConfig, parseConfig } from "./config.js";
import type { AccessoryContext, AccessoryHandler, PluginContext } from "./context.js";
import { describeError } from "./errors.js";
import {
  type GateSpec,
  excludeLatches,
  managerInventory,
  managerInventoryWithoutStatus,
  memberInventory,
} from "./inventory.js";
import { LiveUpdater } from "./live.js";
import { Opener } from "./opener.js";
import { type Session, describeSession, resolveSession } from "./session.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { StateStore } from "./state.js";
import { StreamProbe } from "./streamProbe.js";
import { VERSION } from "./version.js";

/** Seams for tests. Homebridge itself only ever passes the first three arguments. */
export interface PlatformDeps {
  createClient?: (apiKey: string, options: ClientOptions) => NimbioClient;
  /** Delay before retrying startup after a network failure. */
  retryMs?: number;
}

interface Wanted {
  uuid: string;
  role: AccessoryContext["role"];
  gate: GateSpec;
  category: Categories;
  displayName: string;
}

/**
 * Dynamic platform: one API key, many gates.
 *
 * On launch it asks Nimbio who the key belongs to and builds accessories for
 * what that key may do — see {@link resolveSession}. Member keys get open-only
 * garage doors and the plugin makes no further API calls until someone opens a
 * gate. Community-manager keys also get live status and hold-open switches.
 */
export class NimbioPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  /** Characteristics carrying the "No Response" stub, per accessory UUID. */
  private readonly stubbed = new Map<string, Array<{ removeOnGet(): unknown; removeOnSet(): unknown }>>();
  private readonly handlers: AccessoryHandler[] = [];
  private readonly config: NimbioConfig | null;
  private live: LiveUpdater | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly log: Logging,
    raw: PlatformConfig,
    private readonly api: API,
    private readonly deps: PlatformDeps = {},
  ) {
    this.config = parseConfig(raw);
    if (!this.config) {
      // Verified-plugin rule: install cleanly, but do nothing until configured.
      log.warn("No API key configured — add one in the plugin settings. Nimbio is idle.");
      return;
    }
    api.on("didFinishLaunching", () => void this.start());
    api.on("shutdown", () => this.stop());
  }

  /**
   * Homebridge hands back accessories cached from earlier runs. Until a confirmed
   * key attaches real handlers they must not look usable — with no handlers
   * HomeKit would accept "open" and silently do nothing — so each one reports
   * "No Response" from the moment it is restored. That also covers a plugin left
   * unconfigured and a rejected key, where real handlers never arrive.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
    this.markUnavailable(accessory);
  }

  async start(): Promise<void> {
    const config = this.config;
    if (!config || this.stopped) return;
    this.log.info(`Nimbio plugin ${VERSION} starting (${config.environment})`);

    const probe = new StreamProbe();
    const client = (this.deps.createClient ?? ((k, o) => new NimbioClient(k, o)))(config.apiKey, {
      environment: config.environment,
      fetch: probe.wrap(),
      // Open-surface attribution via the long-standing option, not the SDK's newer `integration`.
      defaultHeaders: { "X-Nimbio-Integration": `homebridge/${VERSION}` },
    });

    let session: Session;
    let gates: GateSpec[];
    const store = new StateStore();
    try {
      session = resolveSession(await client.me());
      if (this.stopped) return;
      this.log.info(describeSession(session));
      gates = excludeLatches(await this.loadInventory(client, session, store), config.excludeLatchIds);
      // Shutdown may have arrived during the reads; build nothing after it.
      if (this.stopped) return;
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof AuthenticationError) {
        // Keep cached accessories (rooms, names and automations survive a key
        // fix); they stay "No Response" rather than pretending to work.
        this.log.error("Nimbio rejected the API key. Check it in the plugin settings, then restart Homebridge.");
        return;
      }
      const retryMs = this.deps.retryMs ?? 60_000;
      this.log.warn(`Could not start — ${describeError(e)}. Retrying in ${Math.round(retryMs / 1000)}s.`);
      this.retryTimer = setTimeout(() => void this.start(), retryMs);
      return;
    }

    const ctx: PluginContext = {
      api: this.api,
      log: this.log,
      config,
      client,
      opener: new Opener(client, this.log, session.mode),
      store,
    };
    this.syncAccessories(ctx, this.wanted(gates, session, config));
    this.log.info(`Exposing ${gates.length} gate(s)`);

    const holdOpens = session.holdOpens && config.holdOpenSwitches;
    if (session.gateStatus || holdOpens) {
      this.live = new LiveUpdater(client, store, this.log, {
        liveUpdates: config.liveUpdates,
        pollSeconds: config.pollSeconds,
        gateStatus: session.gateStatus,
        holdOpens,
        probe,
      });
      // loadInventory already read (and seeded) gate status when it could.
      await this.live.start({ gateStatusSeeded: session.gateStatus });
    }
  }

  /** Stub every characteristic of the accessory to report "No Response". */
  private markUnavailable(accessory: PlatformAccessory): void {
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const fail = () => {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    };
    const chars: Array<{ removeOnGet(): unknown; removeOnSet(): unknown }> = [];
    for (const service of accessory.services) {
      if (service instanceof Service.AccessoryInformation) continue;
      for (const ch of service.characteristics) {
        if (ch.UUID === Characteristic.Name.UUID) continue;
        ch.onGet(fail);
        ch.onSet(fail);
        chars.push(ch);
      }
    }
    this.stubbed.set(accessory.UUID, chars);
  }

  /** Remove the stubs so the real handler starts from a clean slate. */
  private clearUnavailable(accessory: PlatformAccessory): void {
    for (const ch of this.stubbed.get(accessory.UUID) ?? []) {
      ch.removeOnGet();
      ch.removeOnSet();
    }
    this.stubbed.delete(accessory.UUID);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.live?.stop();
    for (const h of this.handlers.splice(0)) h.dispose();
  }

  private async loadInventory(client: NimbioClient, session: Session, store: StateStore): Promise<GateSpec[]> {
    if (session.mode === "member") return memberInventory(await client.account.keys());
    if (session.gateStatus) {
      const status = await client.community.gateStatus();
      store.seedGateStatus(status);
      return managerInventory(status);
    }
    return managerInventoryWithoutStatus(await client.community.info());
  }

  private wanted(gates: GateSpec[], session: Session, config: NimbioConfig): Wanted[] {
    const { uuid, Categories } = this.api.hap;
    const out: Wanted[] = [];
    for (const gate of gates) {
      // The role is part of the UUID, so a latch whose type changes (say a
      // sense line is added) becomes a new accessory with the right icon
      // instead of a garage door wearing a lock service.
      const role = gate.kind === "lock" ? "lock" : "gate";
      out.push({
        uuid: uuid.generate(`nimbio:${role}:${gate.latchId}`),
        role,
        gate,
        category: role === "lock" ? Categories.DOOR_LOCK : Categories.GARAGE_DOOR_OPENER,
        displayName: gate.name,
      });
      if (session.holdOpens && config.holdOpenSwitches) {
        out.push({
          uuid: uuid.generate(`nimbio:holdOpen:${gate.latchId}`),
          role: "holdOpen",
          gate,
          category: Categories.SWITCH,
          displayName: `${gate.name} Hold Open`,
        });
      }
    }
    return out;
  }

  private syncAccessories(ctx: PluginContext, wanted: Wanted[]): void {
    const fresh: PlatformAccessory[] = [];
    const existing: PlatformAccessory[] = [];
    const keep = new Set<string>();

    for (const w of wanted) {
      keep.add(w.uuid);
      let accessory = this.cached.get(w.uuid);
      if (accessory) {
        existing.push(accessory);
      } else {
        accessory = new this.api.platformAccessory(w.displayName, w.uuid, w.category);
        this.cached.set(w.uuid, accessory);
        fresh.push(accessory);
      }
      accessory.context = { latchId: w.gate.latchId, role: w.role } satisfies AccessoryContext;
      this.clearUnavailable(accessory);
      this.handlers.push(this.makeHandler(ctx, accessory, w));
    }

    if (fresh.length) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, fresh);
    if (existing.length) this.api.updatePlatformAccessories(existing);

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer available to this key`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.cached.delete(a.UUID);
        this.stubbed.delete(a.UUID);
      }
    }
  }

  private makeHandler(ctx: PluginContext, accessory: PlatformAccessory, w: Wanted): AccessoryHandler {
    switch (w.role) {
      case "lock":
        return new LockAccessory(ctx, accessory, w.gate);
      case "holdOpen":
        return new HoldOpenAccessory(ctx, accessory, w.gate);
      default:
        return new GateAccessory(ctx, accessory, w.gate);
    }
  }
}

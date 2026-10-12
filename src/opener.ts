import { randomUUID } from "node:crypto";
import type { NimbioClient, OpenResult } from "@nimbio/community-api";
import type { Logging } from "homebridge";
import type { Mode } from "./session.js";
import type { GateSpec } from "./inventory.js";
import { describeError } from "./errors.js";

/** Shown in the community's access log next to the open. */
export const OPEN_NOTE = "Apple Home (Homebridge)";

/**
 * The one path every open goes through.
 *
 * Member keys open through a specific Nimbio key on the account; community
 * keys open the latch directly. Every call carries a fresh idempotency key, so
 * the SDK's automatic retry of a dropped request can never fire the gate twice.
 */
export class Opener {
  constructor(
    private readonly client: NimbioClient,
    private readonly log: Logging,
    private readonly mode: Mode,
  ) {}

  async open(gate: GateSpec): Promise<OpenResult> {
    const opts = { note: OPEN_NOTE, idempotencyKey: randomUUID() };
    this.log.info(`${gate.name}: opening…`);
    try {
      const result =
        this.mode === "member"
          ? await this.client.account.open(this.requireKeyId(gate), gate.latchId, opts)
          : await this.client.community.open(gate.latchId, opts);
      this.log.info(
        result.simulated
          ? `${gate.name}: open simulated (test key — the gate did not move)`
          : `${gate.name}: opened`,
      );
      return result;
    } catch (e) {
      this.log.error(`${gate.name}: open failed — ${describeError(e)}`);
      throw e;
    }
  }

  private requireKeyId(gate: GateSpec): string {
    if (!gate.keyId) throw new Error(`no Nimbio key recorded for latch ${gate.latchId}`);
    return gate.keyId;
  }
}

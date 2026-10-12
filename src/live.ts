import { AuthenticationError, type NimbioClient } from "@nimbio/community-api";
import type { Logging } from "homebridge";
import type { LiveUpdates } from "./config.js";
import { describeError, isStreamLimit } from "./errors.js";
import type { StateStore } from "./state.js";

/** The events the plugin renders. The stream and webhooks share this vocabulary. */
export const STREAM_EVENTS = [
  "sense_line.changed",
  "hold_open.changed",
  "device.online",
  "device.offline",
] as const;

export interface LiveOptions {
  liveUpdates: LiveUpdates;
  pollSeconds: number;
  gateStatus: boolean;
  holdOpens: boolean;
  /** Wait before re-opening the stream after an HTTP-level error. */
  streamRetryMs?: number;
  /** Full re-read cadence while the stream is healthy — a safety net, not the feed. */
  safetyResyncMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Keeps the state store current for a community key.
 *
 * Default: the SDK's SSE stream (outbound, so it works behind home NAT with no
 * webhook endpoint). The SDK reconnects dropped connections itself; an
 * HTTP-level refusal (e.g. the 3-streams-per-key limit) falls back to polling
 * and retries the stream later. The status reads are monthly-quota-exempt
 * server-side, so neither polling nor re-seeding spends the key's quota.
 */
export class LiveUpdater {
  private readonly abort = new AbortController();
  private pollTimer: NodeJS.Timeout | undefined;
  private safetyTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly client: NimbioClient,
    private readonly store: StateStore,
    private readonly log: Logging,
    private readonly opts: LiveOptions,
  ) {}

  async start(): Promise<void> {
    await this.seed();
    if (this.opts.liveUpdates === "polling") {
      this.log.info(`Live updates: polling every ${this.opts.pollSeconds}s`);
      this.startPolling();
      return;
    }
    this.safetyTimer = setInterval(() => void this.seed(), this.opts.safetyResyncMs ?? 15 * 60_000);
    void this.runStream();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.stopPolling();
    clearInterval(this.safetyTimer);
  }

  /** Re-read everything this key can see. Never throws. */
  async seed(): Promise<boolean> {
    try {
      if (this.opts.gateStatus) this.store.seedGateStatus(await this.client.community.gateStatus());
      if (this.opts.holdOpens) this.store.seedHoldOpens(await this.client.community.holdOpens());
      if (this.failures > 0) this.log.info("Nimbio status reads recovered");
      this.failures = 0;
      return true;
    } catch (e) {
      this.failures += 1;
      // Warn once per outage, not once per poll.
      const msg = `Could not refresh gate status — ${describeError(e)}`;
      if (this.failures === 1) this.log.warn(msg);
      else this.log.debug(msg);
      return false;
    }
  }

  private async runStream(): Promise<void> {
    const signal = this.abort.signal;
    while (!this.stopped) {
      try {
        // The SDK connects lazily and yields nothing until an event arrives,
        // so this announces the attempt; a refusal surfaces as a warning below.
        this.log.info("Live updates: listening on the Nimbio event stream");
        for await (const msg of this.client.community.streamEvents({ events: STREAM_EVENTS, reconnect: true, signal })) {
          this.stopPolling();
          if (msg.kind === "reset") {
            this.log.debug(`Event stream reset (${msg.reason ?? "no reason"}); re-reading status`);
            await this.seed();
          } else if (this.store.applyEvent(msg) === "resync") {
            await this.seed();
          }
        }
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof AuthenticationError) {
          this.log.error(`Event stream refused — ${describeError(e)}. Live updates stopped.`);
          return;
        }
        const hint = isStreamLimit(e)
          ? " This key already has 3 live streams open (Home Assistant or another Homebridge?) — give each its own key."
          : "";
        this.log.warn(
          `Event stream unavailable — ${describeError(e)}.${hint} Polling every ${this.opts.pollSeconds}s meanwhile.`,
        );
      }
      if (this.stopped) return;
      this.startPolling();
      await sleep(this.opts.streamRetryMs ?? 60_000, signal);
      await this.seed();
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => void this.seed(), this.opts.pollSeconds * 1000);
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

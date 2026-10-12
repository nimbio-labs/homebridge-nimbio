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
  /**
   * A stream attempt that has not failed after this long is treated as
   * connected (the SDK yields nothing until an event arrives, so there is no
   * explicit on-connect signal). Polling stops then.
   */
  streamHealthyMs?: number;
}

/** Ceiling for the stream retry backoff after repeated refusals. */
export const MAX_STREAM_RETRY_MS = 15 * 60_000;

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
  /** Consecutive stream attempts that failed; 0 while the stream is healthy. */
  private streamFailures = 0;
  private stopped = false;

  constructor(
    private readonly client: NimbioClient,
    private readonly store: StateStore,
    private readonly log: Logging,
    private readonly opts: LiveOptions,
  ) {}

  /**
   * Seed, then start the feed. Pass `gateStatusSeeded` when the caller has just
   * read gate status itself (the inventory read), so it is not read twice.
   */
  async start(opts: { gateStatusSeeded?: boolean } = {}): Promise<void> {
    await this.seed({ gateStatus: !opts.gateStatusSeeded });
    // stop() may have run while the seed was in flight (shutdown during startup).
    if (this.stopped) return;
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
  async seed(parts: { gateStatus?: boolean } = {}): Promise<boolean> {
    try {
      if (this.opts.gateStatus && parts.gateStatus !== false) {
        this.store.seedGateStatus(await this.client.community.gateStatus());
      }
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
      // The SDK connects lazily and yields nothing until an event arrives, so an
      // attempt that survives `streamHealthyMs` without an HTTP refusal counts
      // as connected: stop the fallback polling and end any outage.
      const healthy = setTimeout(() => this.markStreamHealthy(), this.opts.streamHealthyMs ?? 15_000);
      try {
        if (this.streamFailures === 0) this.log.info("Live updates: listening on the Nimbio event stream");
        else this.log.debug("Retrying the Nimbio event stream");
        for await (const msg of this.client.community.streamEvents({ events: STREAM_EVENTS, reconnect: true, signal })) {
          this.markStreamHealthy();
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
        this.streamFailures += 1;
        const hint = isStreamLimit(e)
          ? " This key already has 3 live streams open (Home Assistant or another Homebridge?) — give each its own key."
          : "";
        const msg = `Event stream unavailable — ${describeError(e)}.${hint} Polling every ${this.opts.pollSeconds}s meanwhile.`;
        // Warn once per outage; a permanent refusal must not log forever.
        if (this.streamFailures === 1) this.log.warn(msg);
        else this.log.debug(msg);
      } finally {
        clearTimeout(healthy);
      }
      if (this.stopped) return;
      this.startPolling();
      // Back off on repeated refusals: 1x, 2x, 4x … the base delay, capped.
      const base = this.opts.streamRetryMs ?? 60_000;
      const delay = Math.min(base * 2 ** Math.max(0, this.streamFailures - 1), MAX_STREAM_RETRY_MS);
      await sleep(delay, signal);
      await this.seed();
    }
  }

  private markStreamHealthy(): void {
    this.stopPolling();
    if (this.streamFailures > 0) {
      this.log.info("Live updates: event stream reconnected");
      this.streamFailures = 0;
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

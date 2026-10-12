import type { GateStatus, HoldOpens, StreamEvent } from "@nimbio/community-api";

/** Live picture of one latch (manager mode). */
export interface LatchState {
  /** Latest sensed status label, e.g. "Closed", "Moving", "Unknown". */
  status: string | null;
  offline: boolean;
  /** Held open by any source (manual, scheduled event, recurring window). */
  heldOpen: boolean;
  /** The manual hold-open flag — the only one the switch reflects. */
  manualHoldOpen: boolean;
}

type Listener = (state: LatchState) => void;

/** Result of applying a stream event. */
export type ApplyResult = "applied" | "ignored" | "resync";

/**
 * Per-latch state store, seeded from the status reads and patched from the
 * live stream. Port of the coordinator in nimbio-home-assistant, including its
 * rule that the stream and the reads share one event vocabulary.
 */
export class StateStore {
  private readonly latches = new Map<string, LatchState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /**
   * Monotonic write counter, and per latch the counter value of the last
   * live write (event or local hold-open write). A status read records the
   * counter when it starts; when it lands it skips any latch written since,
   * so an older read can never overwrite a newer event.
   */
  private seq = 0;
  private readonly statusSeq = new Map<string, number>();
  private readonly holdSeq = new Map<string, number>();

  get(latchId: string): LatchState | undefined {
    return this.latches.get(latchId);
  }

  subscribe(latchId: string, fn: Listener): () => void {
    let set = this.listeners.get(latchId);
    if (!set) this.listeners.set(latchId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Counter value to pass to the seed methods when a read starts. */
  mark(): number {
    return this.seq;
  }

  seedGateStatus(gs: GateStatus, since = Infinity): void {
    for (const l of gs.latches) {
      if (!l.latchId) continue;
      if ((this.statusSeq.get(l.latchId) ?? -1) > since) continue;
      const cur = this.ensure(l.latchId);
      cur.status = l.status;
      cur.offline = l.offline;
      this.emit(l.latchId);
    }
  }

  seedHoldOpens(ho: HoldOpens, since = Infinity): void {
    for (const [key, entry] of Object.entries(ho.latches)) {
      const latchId = entry.latchId ?? key;
      if ((this.holdSeq.get(latchId) ?? -1) > since) continue;
      const cur = this.ensure(latchId);
      cur.heldOpen = entry.heldOpen;
      cur.manualHoldOpen = entry.manual;
      this.emit(latchId);
    }
  }

  /** Optimistic local update after a successful hold-open write. */
  setManualHoldOpen(latchId: string, on: boolean): void {
    const cur = this.ensure(latchId);
    cur.manualHoldOpen = on;
    if (on) cur.heldOpen = true;
    this.holdSeq.set(latchId, ++this.seq);
    this.emit(latchId);
  }

  applyEvent(ev: StreamEvent): ApplyResult {
    // `ev.data` is the whole webhook envelope ({event, id, occurred_at, data});
    // the event's own fields are in `ev.payload`, which the SDK lifts out of it.
    const data = ev.payload ?? {};
    const latchId = typeof data.latch_id === "string" ? data.latch_id : null;

    if (ev.type === "sense_line.changed" && latchId) {
      const cur = this.latches.get(latchId);
      if (!cur) return "ignored";
      // Transient states (Moving) are applied like any other: the next event
      // carries the settled status.
      if (typeof data.status_label === "string" && data.status_label) {
        cur.status = data.status_label;
        this.statusSeq.set(latchId, ++this.seq);
      }
      this.emit(latchId);
      return "applied";
    }
    if (ev.type === "hold_open.changed" && latchId) {
      const cur = this.latches.get(latchId);
      if (!cur) return "ignored";
      if (typeof data.held_open === "boolean") cur.heldOpen = data.held_open;
      if (typeof data.manual === "boolean") cur.manualHoldOpen = data.manual;
      this.holdSeq.set(latchId, ++this.seq);
      this.emit(latchId);
      return "applied";
    }
    if (ev.type === "device.online" || ev.type === "device.offline") {
      // The payload names the box, not its latches — re-read instead
      // (the status reads are monthly-quota-exempt).
      return "resync";
    }
    return "ignored";
  }

  private ensure(latchId: string): LatchState {
    let cur = this.latches.get(latchId);
    if (!cur) {
      cur = { status: null, offline: false, heldOpen: false, manualHoldOpen: false };
      this.latches.set(latchId, cur);
    }
    return cur;
  }

  private emit(latchId: string): void {
    const cur = this.latches.get(latchId);
    if (!cur) return;
    for (const fn of this.listeners.get(latchId) ?? []) fn(cur);
  }
}

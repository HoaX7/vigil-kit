import type { GuildDelta, SdkEvent } from "./types.js";

const MAX_EVENTS = 200;
const MAX_GUILD_DELTAS = 10_000;

export interface Batch {
  events: SdkEvent[];
  added: GuildDelta[];
  removed: GuildDelta[];
}

/**
 * Everything waiting to be sent on the next heartbeat.
 *
 * Gateway events arrive whenever Discord feels like it, not on our timer, so
 * they queue here and ride along with the next beat rather than each costing a
 * request.
 *
 * Sending is two steps on purpose. `take()` hands over a batch without dropping
 * it, and only `commit()` after a successful send removes exactly what was
 * sent. A failed send therefore keeps its contents for the retry, and anything
 * that arrived while the request was in flight is untouched. Losing a disconnect
 * event because the network blipped would lose it precisely when it explains
 * the outage.
 */
export class Outbox {
  private events: SdkEvent[] = [];
  private added: GuildDelta[] = [];
  private removed: GuildDelta[] = [];

  pushEvent(event: SdkEvent): void {
    this.events.push(event);
    // Under a reconnect storm the newest events describe the current state, so
    // the oldest are what to drop.
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  guildAdded(delta: GuildDelta): void {
    // A join cancels a pending leave for the same guild rather than sending
    // both: reconnects replay membership, and the pair is a no-op the server
    // would have to work out for itself.
    if (!removeMatching(this.removed, delta)) push(this.added, delta);
  }

  guildRemoved(delta: GuildDelta): void {
    if (!removeMatching(this.added, delta)) push(this.removed, delta);
  }

  take(): Batch {
    return {
      events: [...this.events],
      added: [...this.added],
      removed: [...this.removed],
    };
  }

  commit(batch: Batch): void {
    this.events.splice(0, batch.events.length);
    this.added.splice(0, batch.added.length);
    this.removed.splice(0, batch.removed.length);
  }

  get isEmpty(): boolean {
    return this.events.length === 0 && this.added.length === 0 && this.removed.length === 0;
  }
}

function push(list: GuildDelta[], delta: GuildDelta): void {
  if (list.some((d) => d.id === delta.id)) return;
  if (list.length >= MAX_GUILD_DELTAS) return;
  list.push(delta);
}

function removeMatching(list: GuildDelta[], delta: GuildDelta): boolean {
  const index = list.findIndex((d) => d.id === delta.id);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
}

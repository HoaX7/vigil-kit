import type { GuildChange, ShardAdapter } from "./types.js";
import type { BotInfo, GuildDelta, SdkEvent, ShardState, ShardStatus } from "../types.js";
import type { Logger } from "../logger.js";

const MAX_SHARDS = 4096;
const MAX_LATENCY_MS = 600_000;
const READY_TIMEOUT_MS = 60_000;
const STATUSES: readonly ShardStatus[] = ["ready", "disconnected", "resuming", "idle"];

/** The logger the safety layer needs: normal levels, plus say-it-once. */
export type SafeLogger = Logger & { once(key: string, message: string): void };

/**
 * Wraps an adapter so its bugs stay its own.
 *
 * Adapters are the extension point, which means most of them will be written by
 * someone other than us and all of them run inside a stranger's production bot.
 * A throw from `shards()` on a timer, or from a listener attached to the
 * client's own emitter, would otherwise surface as an unhandled rejection in a
 * process that has nothing to do with monitoring.
 *
 * So every call in is guarded and every value out is normalised. The types say
 * an adapter returns a `ShardState[]`; this layer is what makes that true at
 * runtime, because the type is a promise made by code we did not write. A
 * broken adapter degrades to "no data" and says so once, which is the correct
 * failure for a monitoring SDK: visible, and not fatal to the thing watched.
 */
export class SafeAdapter implements ShardAdapter {
  readonly library: string;

  constructor(
    private readonly inner: ShardAdapter,
    private readonly log: SafeLogger,
  ) {
    this.library = typeof inner.library === "string" ? inner.library : "unknown";
  }

  /** Empty on failure. The reporter skips a beat rather than sending nonsense. */
  shards(): ShardState[] {
    const raw = this.guard("shards", () => this.inner.shards(), []);
    if (!Array.isArray(raw)) {
      this.log.once("shards-shape", `adapter ${this.library} returned a non-array from shards()`);
      return [];
    }

    const seen = new Set<number>();
    const out: ShardState[] = [];
    for (const shard of raw) {
      const normalised = normaliseShard(shard);
      // A duplicate shard id would be two conflicting reports of one monitor.
      // First wins, since there is no basis for preferring the second.
      if (!normalised || seen.has(normalised.id)) continue;
      seen.add(normalised.id);
      out.push(normalised);
      if (out.length >= MAX_SHARDS) break;
    }
    return out;
  }

  bot(): BotInfo {
    const raw = this.guard("bot", () => this.inner.bot(), { shardCount: 0 });
    const count = Math.trunc(Number(raw?.shardCount));
    return {
      id: snowflake(raw?.id),
      applicationId: snowflake(raw?.applicationId),
      username: text(raw?.username, 120),
      // Zero is meaningful: it says the client has not spawned yet, and the
      // reporter waits rather than registering a bot with no shards.
      shardCount: Number.isFinite(count) && count > 0 ? Math.min(count, MAX_SHARDS) : 0,
    };
  }

  guilds(): Map<number, Array<{ id: string; name?: string | undefined }>> {
    if (!this.inner.guilds) return new Map();
    const raw = this.guard("guilds", () => this.inner.guilds?.(), undefined);
    if (!(raw instanceof Map)) return new Map();

    const out = new Map<number, Array<{ id: string; name?: string | undefined }>>();
    for (const [shardId, entries] of raw) {
      const id = Math.trunc(Number(shardId));
      if (!Number.isFinite(id) || id < 0 || !Array.isArray(entries)) continue;
      const guilds: Array<{ id: string; name?: string | undefined }> = [];
      for (const entry of entries as Array<{ id?: unknown; name?: unknown }>) {
        const guildId = snowflake(typeof entry?.id === "string" ? entry.id : undefined);
        if (!guildId) continue;
        guilds.push({ id: guildId, name: text(typeof entry?.name === "string" ? entry.name : undefined, 120) });
      }
      out.set(id, guilds);
    }
    return out;
  }

  /**
   * Never rejects, and never waits forever on a `ready()` that is simply wrong.
   * Without the timeout, an adapter whose promise is never settled means a bot
   * that reports nothing, silently, for its whole life.
   */
  async ready(): Promise<void> {
    if (!this.inner.ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = Promise.resolve(this.inner.ready()).then(() => "ready" as const);
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS);
        timer.unref?.();
      });
      // Racing does not cancel the loser, so the outcome has to be inspected
      // rather than the warning fired from inside the timer: an adapter that
      // was ready in a second would otherwise still be accused of being slow
      // sixty seconds later.
      if ((await Promise.race([ready, timeout])) === "timeout") {
        this.log.once("ready-slow", `adapter ${this.library} was not ready within 60s, starting anyway`);
      }
    } catch (err) {
      this.log.once(
        "ready-threw",
        `adapter ${this.library} failed while becoming ready: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  onEvent(listener: (event: SdkEvent) => void): void {
    if (!this.inner.onEvent) return;
    // The listener runs inside the client's emitter, so a throw there lands in
    // the host's event loop rather than ours. Guarded on both sides.
    this.guard(
      "onEvent",
      () =>
        this.inner.onEvent?.((event) => {
          const normalised = normaliseEvent(event);
          if (normalised) this.guard("onEvent:listener", () => listener(normalised), undefined);
        }),
      undefined,
    );
  }

  onGuildChange(listener: (change: GuildChange) => void): void {
    if (!this.inner.onGuildChange) return;
    this.guard(
      "onGuildChange",
      () =>
        this.inner.onGuildChange?.((change) => {
          const added = normaliseDelta(change?.added);
          const removed = normaliseDelta(change?.removed);
          if (!added && !removed) return;
          this.guard("onGuildChange:listener", () => listener({ added, removed }), undefined);
        }),
      undefined,
    );
  }

  dispose(): void {
    this.guard("dispose", () => this.inner.dispose?.(), undefined);
  }

  private guard<T>(what: string, run: () => T, fallback: T): T {
    try {
      return run();
    } catch (err) {
      this.log.once(`adapter-${what}`, `adapter ${this.library} threw in ${what}(): ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }
}

function normaliseShard(shard: ShardState): ShardState | null {
  if (typeof shard !== "object" || shard === null) return null;

  const id = Math.trunc(Number(shard.id));
  if (!Number.isFinite(id) || id < 0 || id >= MAX_SHARDS) return null;

  const status = STATUSES.includes(shard.status) ? shard.status : "disconnected";
  const state: ShardState = { id, status };

  const latency = Number(shard.latencyMs);
  // Libraries use a negative ping to mean "not measured yet", which is not the
  // same as a zero millisecond round trip and must not be recorded as one.
  if (Number.isFinite(latency) && latency >= 0) state.latencyMs = Math.round(Math.min(latency, MAX_LATENCY_MS));

  const guilds = Math.trunc(Number(shard.guilds));
  if (Number.isFinite(guilds) && guilds >= 0) state.guilds = guilds;

  if (shard.lastReadyAt instanceof Date && !Number.isNaN(shard.lastReadyAt.getTime())) {
    state.lastReadyAt = shard.lastReadyAt;
  }

  return state;
}

function normaliseEvent(event: SdkEvent): SdkEvent | null {
  if (typeof event !== "object" || event === null) return null;
  if (typeof event.kind !== "string" || event.kind.length === 0) return null;

  const shardId = Math.trunc(Number(event.shardId));
  const closeCode = Math.trunc(Number(event.closeCode));
  const message = text(event.message, 2_000);
  const stack = text(event.stack, 20_000);

  return {
    kind: event.kind,
    level: event.level === "warn" || event.level === "error" ? event.level : "info",
    ...(Number.isFinite(shardId) && shardId >= 0 ? { shardId } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined ? { stack } : {}),
    ...(Number.isFinite(closeCode) ? { closeCode } : {}),
    at: event.at instanceof Date && !Number.isNaN(event.at.getTime()) ? event.at : new Date(),
  };
}

function normaliseDelta(delta: GuildDelta | undefined): GuildDelta | undefined {
  if (typeof delta !== "object" || delta === null) return undefined;
  const shardId = Math.trunc(Number(delta.shardId));
  const id = snowflake(delta.id);
  if (!Number.isFinite(shardId) || shardId < 0 || !id) return undefined;
  return { shardId, id };
}

/** Discord ids are numeric strings; anything else is not one. */
function snowflake(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined;
  return value;
}

function text(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, max);
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}


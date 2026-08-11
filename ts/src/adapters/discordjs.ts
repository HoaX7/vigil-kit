import { defineAdapter, type GuildChange, type ShardAdapter } from "./types.js";
import type { BotInfo, SdkEvent, ShardState, ShardStatus } from "../types.js";

/**
 * discord.js v14.
 *
 * Everything here is read through structural checks rather than imports, so
 * discord.js stays an optional peer dependency and this file loads fine in a
 * project that uses a different library. It is also the worked example for
 * anyone writing their own: nothing in it uses a private API of the SDK.
 */

/**
 * discord.js `Status`, inlined for the same reason. The numbers are part of the
 * library's public API and any addition would land at the end, so an
 * unrecognised value is treated as "not delivering events" rather than assumed
 * healthy.
 */
const STATUS: Record<number, ShardStatus> = {
  0: "ready",
  1: "disconnected", // Connecting
  2: "disconnected", // Reconnecting
  3: "idle",
  4: "disconnected", // Nearly
  5: "disconnected", // Disconnected
  6: "disconnected", // WaitingForGuilds
  7: "disconnected", // Identifying
  8: "resuming",
};

/** The parts of a discord.js shard this adapter reads. */
export interface DiscordJsShard {
  id: number;
  ping: number;
  status: number;
}

/** The parts of a discord.js guild this adapter reads. */
export interface DiscordJsGuild {
  id: string;
  shardId: number;
  name?: string;
  /** False while Discord is having an outage in that guild. */
  available?: boolean;
}

/** Unwraps Map-style iteration: a Collection yields [key, value] entries. */
function* valuesOf<T>(source: Iterable<T | [unknown, T]> & { values?: () => Iterable<T> }): Iterable<T> {
  if (source.values) {
    yield* source.values();
    return;
  }
  for (const entry of source) {
    yield (Array.isArray(entry) ? entry[1] : entry) as T;
  }
}

/** The WebSocket close payload discord.js passes to `shardDisconnect`. */
export interface DiscordJsCloseEvent {
  code?: number;
  reason?: string;
}

/** Every argument shape this adapter reads off a discord.js event. */
export type DiscordJsEventArg = number | DiscordJsGuild | DiscordJsCloseEvent | Error | undefined;

export type DiscordJsListener = (...args: DiscordJsEventArg[]) => void;

/**
 * The parts of a discord.js `Client` this adapter reads.
 *
 * Declared structurally rather than imported, so nothing here depends on
 * discord.js being installed. Exported so you can see exactly what the adapter
 * touches, and so a wrapper around a client can satisfy it deliberately.
 */
export interface DiscordJsClient {
  ws: {
    /** A Collection (Map) in discord.js itself; a plain iterable also works. */
    shards: Iterable<DiscordJsShard | [number, DiscordJsShard]> & {
      size: number;
      values?: () => Iterable<DiscordJsShard>;
    };
  };
  guilds: {
    cache: Iterable<DiscordJsGuild | [unknown, DiscordJsGuild]> & { values?: () => Iterable<DiscordJsGuild> };
  };
  user?: { id: string; username: string } | null;
  application?: { id: string } | null;
  options?: { shardCount?: number | string };
  isReady?: () => boolean;
  // discord.js returns the client for chaining; this adapter never uses the
  // return value, and a function returning something still satisfies void.
  on(event: string, listener: DiscordJsListener): void;
  off(event: string, listener: DiscordJsListener): void;
  once(event: string, listener: DiscordJsListener): void;
}

function looksLikeDiscordJs(candidate: object): candidate is DiscordJsClient {
  const c = candidate as Partial<DiscordJsClient>;
  return (
    typeof c.on === "function" &&
    typeof c.off === "function" &&
    typeof c.ws === "object" &&
    c.ws !== null &&
    typeof c.guilds === "object" &&
    c.guilds !== null
  );
}

class DiscordJsAdapter implements ShardAdapter {
  readonly library = "discord.js";
  private readonly attached: Array<[string, DiscordJsListener]> = [];
  private readonly lastReady = new Map<number, Date>();

  constructor(private readonly client: DiscordJsClient) {
    this.on("shardReady", (id) => {
      const shardId = asShardId(id);
      if (shardId !== undefined) this.lastReady.set(shardId, new Date());
    });
  }

  shards(): ShardState[] {
    const guildCounts = this.guildCounts();
    const states: ShardState[] = [];
    // discord.js's `ws.shards` is a Collection, which is a Map: iterating it
    // directly yields [id, shard] ENTRIES, and reading `.status` off an entry
    // gave undefined for every shard. `valuesOf` unwraps to the shards.
    for (const shard of valuesOf<DiscordJsShard>(this.client.ws.shards)) {
      states.push({
        id: shard.id,
        status: STATUS[shard.status] ?? "disconnected",
        // discord.js reports -1 until the first gateway heartbeat resolves.
        latencyMs: shard.ping >= 0 ? Math.round(shard.ping) : undefined,
        guilds: guildCounts.get(shard.id) ?? 0,
        lastReadyAt: this.lastReady.get(shard.id),
      });
    }
    return states;
  }

  bot(): BotInfo {
    return {
      id: this.client.user?.id,
      applicationId: this.client.application?.id ?? this.client.user?.id,
      username: this.client.user?.username,
      shardCount: this.shardCount(),
    };
  }

  guilds(): Map<number, Array<{ id: string; name?: string | undefined }>> {
    const byShard = new Map<number, Array<{ id: string; name?: string | undefined }>>();
    for (const guild of valuesOf<DiscordJsGuild>(this.client.guilds.cache)) {
      const list = byShard.get(guild.shardId) ?? [];
      list.push({ id: guild.id, name: guild.name });
      byShard.set(guild.shardId, list);
    }
    return byShard;
  }

  async ready(): Promise<void> {
    if (this.client.isReady?.()) return;
    // `clientReady` in discord.js 14.17+, `ready` before it. One listener,
    // picked by the installed version: subscribing to the old name on a new
    // discord.js prints a deprecation warning into the host bot's logs, and a
    // monitoring SDK has no business putting noise there.
    const event = await this.readyEventName();
    await new Promise<void>((resolve) => {
      this.client.once(event, () => resolve());
    });
  }

  private async readyEventName(): Promise<string> {
    try {
      const mod = (await import("discord.js")) as { version?: string };
      const [major = 0, minor = 0] = (mod.version ?? "").split(".").map(Number);
      if (major > 14 || (major === 14 && minor >= 17)) return "clientReady";
    } catch {
      // Not resolvable from here (bundled, aliased): the old name still works
      // everywhere, at the cost of the warning on new versions.
    }
    return "ready";
  }

  onEvent(listener: (event: SdkEvent) => void): void {
    this.on("shardDisconnect", (event, id) => {
      const close = asCloseEvent(event);
      listener({
        kind: "shard_disconnect",
        level: "error",
        shardId: asShardId(id),
        closeCode: close?.code,
        message: close?.reason,
        at: new Date(),
      });
    });

    this.on("shardReconnecting", (id) => {
      listener({ kind: "shard_reconnect", level: "warn", shardId: asShardId(id), at: new Date() });
    });

    this.on("shardResume", (id, replayed) => {
      listener({
        kind: "shard_resume",
        level: "info",
        shardId: asShardId(id),
        message: typeof replayed === "number" ? `replayed ${replayed} events` : undefined,
        at: new Date(),
      });
    });

    this.on("shardReady", (id) => {
      listener({ kind: "shard_ready", level: "info", shardId: asShardId(id), at: new Date() });
    });

    this.on("shardError", (error, id) => {
      const err = error instanceof Error ? error : undefined;
      listener({
        kind: "error",
        level: "error",
        shardId: asShardId(id),
        message: err?.message,
        stack: err?.stack,
        at: new Date(),
      });
    });
  }

  onGuildChange(listener: (change: GuildChange) => void): void {
    this.on("guildCreate", (guild) => {
      const g = asGuild(guild);
      if (g) listener({ added: { shardId: g.shardId, id: g.id, name: g.name } });
    });

    this.on("guildDelete", (guild) => {
      const g = asGuild(guild);
      if (!g) return;
      // `available: false` is Discord saying the guild is having an outage, not
      // that the bot left it. It fires on every outage and again on recovery,
      // so treating it as a removal would churn membership for no reason.
      if (g.available === false) return;
      listener({ removed: { shardId: g.shardId, id: g.id } });
    });
  }

  dispose(): void {
    for (const [event, listener] of this.attached) this.client.off(event, listener);
    this.attached.length = 0;
  }

  private on(event: string, handler: DiscordJsListener): void {
    this.client.on(event, handler);
    this.attached.push([event, handler]);
  }

  /**
   * `client.ws.shards` is the truth once spawned. `options.shardCount` covers
   * the window before that, and can be the string "auto", which is a request
   * rather than a count, so it does not qualify.
   */
  private shardCount(): number {
    // The larger of the two wins. In a ShardingManager bot each child process
    // holds ONE live shard while `options.shardCount` carries the cluster
    // total, and reporting the local count made every child register the bot
    // as single-sharded. Internal sharding is the mirror image: the option
    // can lag at 1 while the live set is the truth.
    const live = this.client.ws.shards.size;
    const configured = this.client.options?.shardCount;
    return Math.max(live, typeof configured === "number" && configured > 0 ? configured : 0);
  }

  private guildCounts(): Map<number, number> {
    const counts = new Map<number, number>();
    for (const guild of valuesOf<DiscordJsGuild>(this.client.guilds.cache)) {
      counts.set(guild.shardId, (counts.get(guild.shardId) ?? 0) + 1);
    }
    return counts;
  }
}

function asShardId(value: DiscordJsEventArg): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asGuild(value: DiscordJsEventArg): DiscordJsGuild | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const guild = value as Partial<DiscordJsGuild>;
  return typeof guild.id === "string" && typeof guild.shardId === "number" ? (guild as DiscordJsGuild) : undefined;
}

function asCloseEvent(value: DiscordJsEventArg): DiscordJsCloseEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as DiscordJsCloseEvent;
}

export const discordJsAdapter = defineAdapter<DiscordJsClient>({
  library: "discord.js",
  supports: looksLikeDiscordJs,
  create: (client) => new DiscordJsAdapter(client),
});

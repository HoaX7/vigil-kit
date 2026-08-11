import type { BotInfo, GuildDelta, SdkEvent, ShardState } from "../types.js";

/**
 * The seam between Vigil and a Discord library.
 *
 * Everything above this interface is library-agnostic. The transport, the
 * scheduler, the retry policy and the wire format never learn which client they
 * are watching, so supporting a new library means writing one of these and
 * passing it in. Nothing else changes and nothing needs to be published by us.
 *
 * Three members are required. Every other one is optional and its absence costs
 * exactly the feature it powers, so a first adapter is genuinely small and can
 * grow later. New optional members may be added in a minor release, which is
 * why implementations should not be exhaustive `switch`es over this shape.
 *
 * An adapter only ever reads. It does not connect, log in, send, or touch the
 * bot token.
 *
 * Adapters are treated as untrusted: every call the SDK makes into one is
 * wrapped, so a bug in an adapter degrades reporting rather than taking down
 * the bot it is installed in. Implementations are still expected not to throw.
 */
export interface ShardAdapter {
  /** Identifies the library in logs and in the handshake, e.g. "discord.js". */
  readonly library: string;

  /**
   * Current state of every shard the client owns.
   *
   * Called once per heartbeat, so it must be cheap and must not do I/O. Return
   * what the client already knows rather than asking the gateway.
   */
  shards(): ShardState[];

  /** Identity and shard count. Fields may be absent before the client connects. */
  bot(): BotInfo;

  /**
   * Guild ids per shard, sent once on handshake.
   *
   * Optional. Feeds the roster sync that powers "which shard is my server
   * on"; names are optional and shown when present.
   */
  guilds?(): Map<number, Array<{ id: string; name?: string | undefined }>>;

  /**
   * Resolves once the client is connected enough to describe itself.
   *
   * Optional; without it reporting starts immediately. Implement it if the
   * library spawns shards asynchronously, so the first handshake registers the
   * real shard count instead of a guess.
   */
  ready?(): Promise<void>;

  /**
   * Gateway lifecycle worth recording: disconnects with their close codes,
   * resumes, errors. This is what turns "shard 7 went down" into "shard 7 got
   * close code 4004", which is a different problem with a different fix.
   */
  onEvent?(listener: (event: SdkEvent) => void): void;

  /**
   * Membership changes.
   *
   * Implementations must filter out the unavailable case: Discord fires a
   * delete when a guild goes down in an outage, and again when it comes back,
   * neither of which means the bot left.
   */
  onGuildChange?(listener: (change: GuildChange) => void): void;

  /** Detaches every listener this adapter attached. Called on `stop()`. */
  dispose?(): void;
}

export interface GuildChange {
  added?: GuildDelta | undefined;
  removed?: GuildDelta | undefined;
}

/**
 * Recognises a client and wraps it.
 *
 * `supports` is a type predicate, so `create` receives the narrowed client and
 * needs no cast. Write the predicate against whatever your library actually
 * exposes: the SDK never inspects the client itself, it only asks you.
 */
export interface AdapterFactory<TClient extends object = object> {
  readonly library: string;
  supports(candidate: object): candidate is TClient;
  create(client: TClient): ShardAdapter;
}

/**
 * A factory whose client type has been erased, for holding several of them in
 * one list. Any `AdapterFactory<T>` is one of these.
 */
export type AnyAdapterFactory = AdapterFactory<object>;

/** Anything `watch` accepts: a Discord client, or an adapter you built. */
export type WatchSource<TClient extends object = object> = TClient | ShardAdapter;

/** Structural check, so an adapter from another copy of this package still counts. */
export function isShardAdapter(value: object): value is ShardAdapter {
  const a = value as Partial<ShardAdapter>;
  return typeof a.library === "string" && typeof a.shards === "function" && typeof a.bot === "function";
}

export function isAdapterFactory(value: object): value is AnyAdapterFactory {
  const f = value as Partial<AnyAdapterFactory>;
  return typeof f.library === "string" && typeof f.supports === "function" && typeof f.create === "function";
}

/**
 * Builds a factory, inferring the client type from the predicate so `create`
 * is typed without you writing the type twice:
 *
 *     interface MyClient { shardManager: { total: number } }
 *
 *     export const myAdapter = defineAdapter({
 *       library: "my-library",
 *       supports: (c): c is MyClient => "shardManager" in c,
 *       create: (client) => ({
 *         library: "my-library",
 *         shards: () => [...],
 *         bot: () => ({ shardCount: client.shardManager.total }),
 *       }),
 *     });
 *
 * `client` is `MyClient` inside `create`, with no cast and no `any`.
 */
export function defineAdapter<TClient extends object>(
  definition: AdapterFactory<TClient>,
): AdapterFactory<TClient> {
  return definition;
}

import { resolveAdapter } from "./adapters/resolve.js";
import { SafeAdapter } from "./adapters/safe.js";
import { resolveConfig, type VigilOptions } from "./config.js";
import { createLogger } from "./logger.js";
import { Reporter, type Watcher } from "./reporter.js";
import type { WatchSource } from "./adapters/types.js";

export {
  builtinAdapters,
  defineAdapter,
  discordJsAdapter,
  isAdapterFactory,
  isShardAdapter,
  resolveAdapter,
  SafeAdapter,
  type AdapterFactory,
  type AnyAdapterFactory,
  type DiscordJsClient,
  type DiscordJsCloseEvent,
  type DiscordJsEventArg,
  type DiscordJsGuild,
  type DiscordJsListener,
  type DiscordJsShard,
  type GuildChange,
  type Resolution,
  type ResolveOptions,
  type SafeLogger,
  type ShardAdapter,
  type WatchSource,
} from "./adapters/index.js";
export type { FetchLike, VigilOptions } from "./config.js";
export type { Logger } from "./logger.js";
export type { Watcher } from "./reporter.js";
export type {
  BotInfo,
  GuildDelta,
  HandshakePayload,
  HeartbeatPayload,
  IngestPayload,
  IngestResponse,
  SdkEvent,
  ShardState,
  ShardStatus,
  WireEvent,
  WireGuildDelta,
  WireShardBeat,
} from "./types.js";

/**
 * Reports every shard of a Discord bot to Vigil.
 *
 *     import { watch } from "@hoax7/vigil-sdk";
 *     watch(client);
 *
 * `source` is your Discord client, or an adapter if you built one. Its type
 * flows through to `options.adapter`, so a factory you pass receives your own
 * client type in `create` with no cast. Reads `VIGIL_TOKEN` and
 * `VIGIL_PROJECT_ID` from the environment unless given explicitly.
 *
 * Every dependency is injected rather than reached for: the adapter, the logger
 * and the HTTP implementation all arrive through `options`, so nothing here
 * depends on global state or on which modules were imported first.
 *
 * This function does not throw and does not reject. A missing token, an
 * unrecognised client, an adapter that throws on every call, a Vigil outage:
 * each is logged once and the bot carries on. Monitoring is not worth an
 * incident of its own.
 */
export function watch<TClient extends object>(
  source: WatchSource<TClient>,
  options: VigilOptions<TClient> = {},
): Watcher {
  const log = createLogger(options.silent ?? false, options.logger);

  const config = resolveConfig(options);
  if ("error" in config) {
    log.warn(`${config.error}. Not reporting.`);
    return inert();
  }

  const resolved = resolveAdapter(source, options);
  if (!resolved.ok) {
    log.warn(`${resolved.reason}. Not reporting.`);
    return inert();
  }

  // Community adapters run inside someone else's production bot, so the SDK
  // treats every one of them, including its own, as capable of throwing.
  const reporter = new Reporter(config, new SafeAdapter(resolved.adapter, log));
  reporter.start();
  return reporter;
}

/** A watcher that does nothing, so callers never branch on a null. */
function inert(): Watcher {
  return { stop: () => {}, flush: async () => {} };
}

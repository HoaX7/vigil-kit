import type { ShardAdapter } from "./adapters/index.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import { Outbox } from "./outbox.js";
import { backoffDelay, Transport } from "./transport.js";
import type { Batch } from "./outbox.js";
import type { ShardState } from "./types.js";

const NAME = "@hoax7/vigil-sdk";
const VERSION = "0.1.0";
/** Bootstrap pacing only: how often to try until the server states the plan's
    cadence. Never a recording assumption, the backend owns that number. The
    interval is initialised from this and so is never undefined. */
const DEFAULT_INTERVAL_S = 60;
/** The fastest any retry may come, and the base the backoff doubles from. */
const ATTEMPT_FLOOR_MS = 30_000;
/** Guilds per roster chunk: about 60KB of JSON, inside the body cap. */
const GUILD_PAGE = 1_000;

export interface Watcher {
  /** Stops reporting and detaches every listener. Safe to call twice. */
  stop(): void;
  /** Sends a beat now, outside the schedule. Resolves once it is delivered. */
  flush(): Promise<void>;
}

/**
 * The loop: wait for the client, register once, then beat until stopped.
 *
 * No decision about a shard's health is made here. The SDK reports what the
 * gateway says and the server decides what that means, which is why a network
 * partition between the bot and Vigil reads as an outage rather than as
 * silence: the absence of these beats is itself the signal.
 */
export class Reporter implements Watcher {
  private readonly log: ReturnType<typeof createLogger>;
  private readonly transport: Transport;
  private readonly outbox = new Outbox();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private registered = false;
  private intervalMs = DEFAULT_INTERVAL_S * 1_000;
  private failures = 0;
  /** Set by a 429 response; consumed by the next `schedule()`. */
  private retryAfterMs: number | null = null;
  private syncingGuilds = false;
  /**
   * Serialises every send. Without it, `flush()` called while the startup beat
   * is still in flight runs a second one concurrently, and both see
   * `registered === false`, so the bot registers twice and beats twice.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly adapter: ShardAdapter,
  ) {
    this.log = createLogger(config.silent, config.logger);
    this.transport = new Transport(config, `${NAME}/${VERSION} (${adapter.library})`);
    if (config.intervalSeconds !== undefined) {
      // Accepted so existing configs keep working, but the server's plan
      // cadence always wins: a number pinned here froze today's plan into the
      // bot's codebase and had it rate limited after every upgrade.
      this.log.once("pinned-interval", "intervalSeconds is ignored: the cadence always comes from the server");
    }
  }

  start(): void {
    this.adapter.onEvent?.((event) => this.outbox.pushEvent(event));
    this.adapter.onGuildChange?.(({ added, removed }) => {
      if (added) this.outbox.guildAdded(added);
      if (removed) this.outbox.guildRemoved(removed);
    });

    void Promise.resolve(this.adapter.ready?.()).then(() => {
      if (this.stopped) return;
      this.log.info(`watching ${this.adapter.bot().shardCount} shard(s) via ${this.adapter.library}`);
      void this.cycle();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.adapter.dispose?.();
  }

  async flush(): Promise<void> {
    await this.enqueue();
  }

  /** One beat, then schedule the next. Never rejects. */
  private async cycle(): Promise<void> {
    if (this.stopped) return;
    await this.enqueue();
    this.schedule();
  }

  /**
   * Runs one send after whatever is already running, and never rejects, so a
   * failure cannot poison the chain for every send after it.
   */
  private enqueue(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await this.send();
      } catch (err) {
        this.log.once("send-threw", `reporting failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return this.queue;
  }

  private schedule(): void {
    if (this.stopped) return;
    // A 429 told us exactly when the next beat will be accepted, so the next
    // attempt lands just after that moment instead of on a generic backoff
    // that drifts out of phase with the server's window and skips intervals.
    //
    // A failing endpoint is backed off, so an outage on our side does not
    // turn into a steady request stream from every bot that uses us. The cap
    // is the beat interval itself (never under a minute): backing off past
    // the cadence would delay recovery, and retrying FASTER than the cadence
    // during an outage would be more traffic at the worst time.
    const delay =
      this.retryAfterMs !== null
        ? this.retryAfterMs + 1_000
        : this.failures > 0
          ? backoffDelay(this.failures - 1, ATTEMPT_FLOOR_MS, Math.max(this.intervalMs, 60_000))
          : this.intervalMs;
    this.retryAfterMs = null;
    if (this.failures > 0) {
      this.log.info(`retry ${this.failures} scheduled in ${Math.round(delay / 1_000)}s`);
    }
    this.timer = setTimeout(() => void this.cycle(), delay);
    // Reporting must never be the reason a process stays alive.
    this.timer.unref?.();
  }

  private async send(): Promise<void> {
    // An adapter that reports no shards has nothing to say, whether the client
    // is still spawning or the adapter is broken. Sending an empty beat would
    // be rejected as malformed and would say nothing either way, so the beat is
    // skipped and the shards go stale on their own, which is the truth.
    const shards = this.adapter.shards();
    if (shards.length === 0) {
      this.log.once("no-shards", `adapter ${this.adapter.library} reported no shards, waiting`);
      return;
    }

    if (!this.registered && !(await this.handshake())) return;

    const batch = this.outbox.take();
    const result = await this.transport.post("/v1/ingest", this.heartbeatPayload(shards, batch));
    this.log.info(`heartbeat: ${shards.length} shard(s) → ${result.status === 0 ? "no answer" : `HTTP ${result.status}`}`);

    if (result.status === 409) {
      // The server has no shards for this bot: a fresh deployment, a deleted
      // bot, or a token that now points somewhere else. Re-register and let the
      // next beat carry the data.
      this.registered = false;
      return;
    }
    if (!this.accept(result, "heartbeat")) return;

    this.outbox.commit(batch);
    this.applyServerInterval(result.body?.interval_s);
    this.warnAboutSuspended(result.body?.suspended_shards);
  }

  private async handshake(): Promise<boolean> {
    const bot = this.adapter.bot();
    if (bot.shardCount <= 0) {
      // The client has not spawned yet. Registering now would create the wrong
      // number of monitors and the correction would look like a reshard.
      this.log.once("no-shard-count", "waiting for the client to report its shard count");
      return false;
    }
    // Counts ride the handshake; the roster itself is streamed in chunks
    // afterwards, because a multi-shard process carrying thousands of guild
    // rows in one body would blow the request cap.
    const guilds = this.adapter.guilds?.() ?? new Map<number, Array<{ id: string; name?: string }>>();
    const result = await this.transport.post("/v1/handshake", {
      project_id: this.config.projectId,
      bot: {
        id: bot.id,
        application_id: bot.applicationId,
        username: bot.username,
        shard_count: bot.shardCount,
      },
      shards: [...guilds].map(([id, list]) => ({ id, guild_count: list.length })),
      sdk: { name: NAME, version: VERSION, runtime: `node/${process.versions.node}` },
    });

    this.log.info(`handshake: ${bot.shardCount} shard(s) → ${result.status === 0 ? "no answer" : `HTTP ${result.status}`}`);
    if (!this.accept(result, "handshake")) return false;
    this.registered = true;
    this.applyServerInterval(result.body?.interval_s);
    // In the background, never blocking the heartbeat that follows.
    void this.syncGuilds(guilds);
    return true;
  }

  /**
   * Streams each local shard's roster in pages of 1,000, so the dashboard can
   * answer "which shard is my server on". Every page is logged, a 429 waits
   * out the server's own answer, and any other failure abandons the sync with
   * a warning: the next boot's handshake starts a fresh one, and monitoring
   * itself never depended on it.
   */
  private async syncGuilds(guilds: Map<number, Array<{ id: string; name?: string | undefined }>>): Promise<void> {
    if (this.syncingGuilds) return;
    this.syncingGuilds = true;
    try {
      for (const [shardId, list] of guilds) {
        const pages = Math.max(1, Math.ceil(list.length / GUILD_PAGE));
        for (let page = 1; page <= pages; page++) {
          if (this.stopped) return;
          const chunk = list.slice((page - 1) * GUILD_PAGE, page * GUILD_PAGE);
          const result = await this.transport.post("/v1/guilds", { shard_id: shardId, page, guilds: chunk });

          if (result.status === 429) {
            const wait = (result.body?.retry_after_s ?? 30) * 1_000;
            this.log.info(`guild sync shard ${shardId}: rate limited, resuming in ${Math.round(wait / 1_000)}s`);
            await new Promise((r) => setTimeout(r, wait));
            page--;
            continue;
          }
          if (result.status < 200 || result.status >= 300) {
            this.log.warn(`guild sync shard ${shardId}: page ${page}/${pages} failed (status ${result.status}), giving up until next connect`);
            return;
          }
          const sent = Math.min(page * GUILD_PAGE, list.length);
          this.log.info(`guild sync shard ${shardId}: ${sent}/${list.length} (page ${page}/${pages})`);
        }
      }
    } finally {
      this.syncingGuilds = false;
    }
  }

  private heartbeatPayload(shards: ShardState[], batch: Batch) {
    return {
      sent_at: new Date().toISOString(),
      shards: shards.map(toWire),
      process: {
        rss_bytes: process.memoryUsage().rss,
        uptime_s: Math.round(process.uptime()),
      },
      events: batch.events.map((e) => ({
        kind: e.kind,
        level: e.level,
        shard_id: e.shardId,
        message: e.message,
        stack: e.stack,
        close_code: e.closeCode,
        at: e.at.toISOString(),
      })),
      guilds: {
        added: batch.added.map((g) => ({ shard_id: g.shardId, id: g.id, name: g.name })),
        removed: batch.removed.map((g) => ({ shard_id: g.shardId, id: g.id })),
      },
    };
  }

  /**
   * Decides whether a response counts as delivered, and says something useful
   * exactly once when it does not.
   */
  private accept(result: { status: number; body: { retry_after_s?: number } | null }, what: string): boolean {
    const status = result.status;
    if (status >= 200 && status < 300) {
      if (this.failures > 0) this.log.info("reporting recovered");
      this.failures = 0;
      return true;
    }

    this.failures++;

    if (status === 401) {
      /**
       * The token names no bot: it was mistyped, regenerated, or the bot was
       * deleted. None of those can right themselves while this process runs,
       * because the token is read from the environment at startup, so beating
       * on would be noise forever against an endpoint that will keep refusing.
       * The bot itself carries on; only the reporting stops.
       */
      this.log.error(
        "token rejected, so this bot is not being monitored. It was deleted, or VIGIL_TOKEN is wrong or has been " +
          "regenerated. Reporting has stopped; fix the token and restart to resume.",
      );
      this.stop();
      return false;
    }
    if (status === 400) {
      this.log.once("400", `${what} rejected as malformed, which is a bug in this SDK, please report it`);
      return false;
    }
    if (status === 403) {
      this.log.once("403", "this project does not belong to the bot's team, check VIGIL_PROJECT_ID");
      return false;
    }
    if (status === 429) {
      const after = result.body?.retry_after_s;
      if (after && after > 0) this.retryAfterMs = after * 1_000;
      this.log.info(`rate limited${after ? `, next attempt in ${after}s` : ", backing off"}`);
      return false;
    }
    // Anything else, including status 0 for "never got an answer", is treated
    // as transient and retried quietly.
    this.log.once(`fail-${status}`, `${what} failed (status ${status}), retrying in the background`);
    return false;
  }

  /**
   * The server's cadence, adopted always: the backend derives it from the
   * plan and repeats it on every response, so an upgrade takes effect on the
   * next beat. A response without one is an older backend; the bot keeps its
   * current pace, says so once, and the server's own rate limit corrects any
   * excess.
   */
  private applyServerInterval(seconds: number | undefined): void {
    if (!seconds || seconds <= 0) {
      this.log.once(
        "no-interval",
        `server did not send a cadence, beating every ${Math.round(this.intervalMs / 1_000)}s until it does`,
      );
      return;
    }
    const ms = seconds * 1_000;
    if (ms !== this.intervalMs) {
      this.intervalMs = ms;
      this.log.info(`cadence set by server: every ${seconds}s`);
    }
  }

  private warnAboutSuspended(shards: number[] | undefined): void {
    if (!shards || shards.length === 0) return;
    this.log.once(
      "suspended",
      `${shards.length} shard(s) are over your plan's monitor allowance and are not being monitored: ${shards.join(", ")}`,
    );
  }
}

/** Local wall-clock time for send logs, e.g. `14:38:58`. */
function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function toWire(shard: ShardState) {
  return {
    id: shard.id,
    status: shard.status,
    latency_ms: shard.latencyMs,
    guilds: shard.guilds,
    last_ready_at: shard.lastReadyAt?.toISOString(),
  };
}

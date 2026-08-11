import type { AdapterFactory, AnyAdapterFactory, ShardAdapter } from "./adapters/types.js";
import type { Logger } from "./logger.js";

/** The subset of `fetch` this SDK uses, so a stand-in need not be the whole thing. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface VigilOptions<TClient extends object = object> {
  /** Ingest token for this bot. Defaults to `VIGIL_TOKEN`. */
  token?: string;
  /** Project the shards report into. Defaults to `VIGIL_PROJECT_ID`. */
  projectId?: string;
  /** Ingest base URL. Defaults to `VIGIL_URL`, then to Vigil's own API. */
  url?: string;
  /**
   * Ignored. The cadence always comes from the server, which derives it from
   * your plan and restates it on every response, so upgrades apply on the
   * next beat with no redeploy. Kept so existing configs do not break; the
   * SDK logs once that it is ignored.
   */
  intervalSeconds?: number;
  /** Silences every log line, including the ones explaining a misconfiguration. */
  silent?: boolean;
  logger?: Logger;

  /**
   * Your own adapter, or a factory for one. Tried before anything built in, so
   * this both adds support for a new library and overrides ours for one we
   * already handle.
   */
  adapter?: ShardAdapter | AdapterFactory<TClient>;
  /** Extra factories to try in order, for a process watching several libraries. */
  adapters?: readonly AnyAdapterFactory[];
  /** Replaces the built-in factories. An empty array turns detection off. */
  builtins?: readonly AnyAdapterFactory[];

  /**
   * HTTP implementation. Injected rather than reached for, so the reporter can
   * be driven in a test, put behind a proxy, or given an instrumented client,
   * without this package knowing about any of those.
   */
  fetch?: FetchLike;
}

export interface Config {
  token: string;
  projectId: string;
  url: string;
  /** Set means the caller pinned it, so the server's suggestion is ignored. */
  intervalSeconds?: number | undefined;
  silent: boolean;
  logger?: Logger | undefined;
  fetch?: FetchLike | undefined;
}

// The production ingest, straight to the API. Heartbeats are machine to
// machine with a token, so they skip the app's proxy rather than paying for a
// hop on every beat. Local development overrides this with VIGIL_URL, which
// the dashboard's credential block includes automatically.
const DEFAULT_URL = "https://api.tryvigil.dev";

/**
 * Options first, environment second.
 *
 * Returns a reason rather than throwing when something is missing. A monitoring
 * SDK that halts a bot at boot because its own token is absent has caused the
 * outage it was installed to report.
 */
export function resolveConfig(options: VigilOptions<object> = {}): Config | { error: string } {
  const token = options.token ?? process.env.VIGIL_TOKEN;
  const projectId = options.projectId ?? process.env.VIGIL_PROJECT_ID;
  const pinned = options.intervalSeconds ?? numberFromEnv(process.env.VIGIL_INTERVAL_SECONDS);

  if (!token) return { error: "no token: set VIGIL_TOKEN or pass { token }" };
  if (!projectId) return { error: "no project: set VIGIL_PROJECT_ID or pass { projectId }" };

  return {
    token,
    projectId,
    url: stripTrailingSlash(options.url ?? process.env.VIGIL_URL ?? DEFAULT_URL),
    // Clamped, not trusted. The floor matches the server's rate limit of one
    // heartbeat per 28 seconds, so a pinned value cannot make the SDK 429
    // itself; an hour would leave a dead shard looking alive long past any
    // useful alert.
    intervalSeconds: pinned === undefined ? undefined : Math.min(3_600, Math.max(28, pinned)),
    silent: options.silent ?? false,
    logger: options.logger,
    fetch: options.fetch,
  };
}

function numberFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

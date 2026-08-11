import { discordJsAdapter } from "./discordjs.js";
import {
  isAdapterFactory,
  isShardAdapter,
  type AdapterFactory,
  type AnyAdapterFactory,
  type ShardAdapter,
  type WatchSource,
} from "./types.js";

/**
 * Adapters that ship in the box, tried in order.
 *
 * Exported as data rather than hidden in a module-level array that a
 * `registerAdapter` call mutates. A global registry makes the result of `watch`
 * depend on which files happened to be imported first, which is invisible in a
 * bundle and impossible to test twice in one process. Callers compose this list
 * instead: keep it, extend it, or replace it.
 */
export const builtinAdapters: readonly AnyAdapterFactory[] = [discordJsAdapter];

export interface ResolveOptions<TClient extends object = object> {
  /**
   * An adapter, or a factory for one. Tried before anything built in, so this
   * both adds support for a new library and overrides ours for one we already
   * handle.
   */
  adapter?: ShardAdapter | AdapterFactory<TClient> | undefined;
  /** Extra factories to try, in order, before the built-in ones. */
  adapters?: readonly AnyAdapterFactory[] | undefined;
  /** Replaces the built-in list outright. An empty array disables detection. */
  builtins?: readonly AnyAdapterFactory[] | undefined;
}

export type Resolution = { ok: true; adapter: ShardAdapter } | { ok: false; reason: string };

/**
 * Works out what is being watched.
 *
 * `source` is the client, or an adapter that already holds one. Resolution is
 * pure: same inputs, same result, with no dependence on import order or on what
 * another part of the process registered earlier.
 */
export function resolveAdapter<TClient extends object>(
  source: WatchSource<TClient>,
  options: ResolveOptions<TClient> = {},
): Resolution {
  const client: object | null = typeof source === "object" && source !== null ? source : null;

  // An adapter given directly wins. It was passed on purpose.
  const supplied = options.adapter;
  if (supplied) {
    if (isShardAdapter(supplied)) return { ok: true, adapter: supplied };
    if (isAdapterFactory(supplied)) {
      if (client && supplied.supports(client)) {
        return { ok: true, adapter: supplied.create(client as TClient) };
      }
      return { ok: false, reason: `the ${supplied.library} adapter did not recognise this client` };
    }
    return { ok: false, reason: "options.adapter is neither an adapter nor an adapter factory" };
  }

  if (!client) return { ok: false, reason: "no client given. Pass your Discord client, or an adapter" };

  // `watch(myAdapter)`: the adapter already holds its own client.
  if (isShardAdapter(client)) return { ok: true, adapter: client };

  const factories = [...(options.adapters ?? []), ...(options.builtins ?? builtinAdapters)];
  for (const factory of factories) {
    if (factory.supports(client)) return { ok: true, adapter: factory.create(client) };
  }

  const tried = factories.map((f) => f.library).join(", ") || "none";
  return {
    ok: false,
    reason: `unrecognised Discord client (tried: ${tried}). Pass your client instance, or an adapter via { adapter }`,
  };
}

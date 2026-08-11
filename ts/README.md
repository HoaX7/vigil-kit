# @hoax7/vigil-sdk

Report every shard of your Discord bot to [Vigil](https://tryvigil.dev).

A sharded bot fails quietly by design. One gateway connection drops, Discord
keeps showing the bot as online, and a slice of your servers gets silence until
someone complains. Nothing outside your process can see it. So the bot tells us,
and we do the rest.

```bash
npm install @hoax7/vigil-sdk
```

```ts
import { Client } from "discord.js";
import { watch } from "@hoax7/vigil-sdk";

const client = new Client({ shards: "auto", intents: [] });
watch(client);
```

That is the whole integration. `watch` reads `VIGIL_TOKEN` and
`VIGIL_PROJECT_ID` from your environment, waits for the client to connect, and
reports each shard from then on.

```bash
VIGIL_TOKEN=vgl_...
VIGIL_PROJECT_ID=...
```

Both come as a ready-to-paste env block when you
[add a bot](https://tryvigil.dev/dashboard/new?kind=discord) in your Vigil
dashboard. Shards appear automatically on the first connect, one monitor each,
and you never create them by hand.

## What it reports

Per shard, on every beat:

| | |
| --- | --- |
| Status | ready, resuming, disconnected or idle |
| Gateway latency | the heartbeat round trip |
| Guild count | how many servers sit on that shard |

Plus the gateway events that explain a failure when one happens: disconnects
with their WebSocket close code, reconnects, resumes and errors. Close code 4004
means a bad token. 1006 means the network dropped. Knowing which is most of the
value.

Liveness is the absence of a beat. If a shard stops reporting, Vigil opens an
incident naming that shard while the rest of your cluster carries on unflagged.
Nothing in this package decides a shard is down, so a network partition between
your bot and us reads as an outage rather than as silence.

## What it will not do

**It never crashes your bot.** Every failure path is swallowed and retried with
backoff: a missing token, a rejected token, our servers being down, DNS failing.
The worst case is that your shards show as down while your bot runs perfectly.
Monitoring is not worth an incident of its own.

**It never reads your bot token.** It takes your client object and reads shard
state from it. Nothing else.

**It never opens a port.** All traffic is outbound, so it works behind NAT with
no configuration.

**It never blocks startup.** `watch` returns immediately and does its work in
the background. The timer is unreferenced, so it will not keep a finished
process alive.

## Options

```ts
watch(client, {
  token: process.env.MY_TOKEN,       // default: VIGIL_TOKEN
  projectId: process.env.MY_PROJECT, // default: VIGIL_PROJECT_ID
  url: "https://api.tryvigil.dev",   // default: VIGIL_URL, then Vigil's API
  silent: false,                     // no log output at all
  logger: myLogger,                  // anything with info, warn and error
  adapter: myAdapter,                // your own, see below
  fetch: myFetch,                    // your own HTTP, for tests or a proxy
});
```

`intervalSeconds` is accepted and ignored. The server sets the cadence from
your plan and restates it on every response, so an upgrade applies on the next
beat with no redeploy. Passing it logs once and changes nothing; it exists so
older configs keep working.

`watch` returns a handle you can usually ignore:

```ts
const watcher = watch(client);
await watcher.flush(); // send a beat now, outside the schedule
watcher.stop();        // stop reporting and detach every listener
```

## Writing an adapter

discord.js works out of the box. Everything else is an adapter, and adapters are
passed in rather than registered globally, so yours needs nothing from us: no
pull request, no plugin key, no import-order tricks. Publish it as its own
package and people use it by passing it to `watch`.

An adapter has three required members. That is the whole contract.

```ts
import { defineAdapter, watch } from "@hoax7/vigil-sdk";

interface MyClient {
  shardManager: { total: number; each(): Array<{ index: number; alive: boolean; rtt: number }> };
}

export const myAdapter = defineAdapter({
  library: "my-library",
  supports: (c): c is MyClient => "shardManager" in c,
  create: (client) => ({
    library: "my-library",
    shards: () =>
      client.shardManager.each().map((s) => ({
        id: s.index,
        status: s.alive ? "ready" : "disconnected",
        latencyMs: s.rtt,
      })),
    bot: () => ({ shardCount: client.shardManager.total }),
  }),
});
```

`client` is `MyClient` inside `create`, inferred from your own type predicate,
with no cast and no `any`. Then:

```ts
watch(client, { adapter: myAdapter });
```

Or skip the factory and hand `watch` an adapter you already built:

```ts
watch(myAdapter.create(client));
```

### Everything else is optional

| Member | Without it |
| --- | --- |
| `guilds()` | No guild ids on handshake. Costs nothing today, since the shard lookup is arithmetic |
| `ready()` | Reporting starts immediately instead of waiting for the client to spawn |
| `onEvent()` | No close codes or resumes, so an outage says "down" without saying why |
| `onGuildChange()` | No membership deltas |
| `dispose()` | `stop()` cannot detach your listeners |

New optional members may appear in a minor release, so do not write an adapter
as an exhaustive match on this shape.

### What the SDK does with yours

Your adapter is wrapped before it is used, because it runs inside somebody
else's production bot:

- **Every call is guarded.** A throw from `shards()` on the timer, or from a
  listener you attached to the client's emitter, is caught, logged once, and
  degrades to "no data" instead of surfacing as an unhandled rejection in a
  process that has nothing to do with monitoring.
- **Every value is normalised.** Shard ids are coerced to whole numbers and
  deduplicated, unknown statuses become `disconnected`, negative latencies are
  dropped rather than recorded as zero, absurd values are clamped, and anything
  that is not a Discord snowflake is discarded.
- **`ready()` is raced against a timeout.** A promise that never settles would
  otherwise mean a bot that silently reports nothing for its whole life.

So an adapter should not throw, but the SDK does not depend on that.

### Composing the list

```ts
watch(client, { adapters: [myAdapter, someoneElsesAdapter] }); // tried before ours
watch(client, { adapters: [myAdapter], builtins: [] });        // only yours
```

Resolution is a pure function of what you pass. There is no global registry, so
the result never depends on which module happened to be imported first, and two
different configurations can exist in one process.

`resolveAdapter`, `builtinAdapters`, `SafeAdapter` and every type above are
exported if you want to test a resolution or wrap an adapter yourself.

### Types

All of them are exported: `ShardAdapter`, `AdapterFactory`, `ShardState`,
`BotInfo`, `SdkEvent`, `GuildDelta`, `Watcher`, `VigilOptions`, plus the wire
types (`HandshakePayload`, `HeartbeatPayload`, `IngestResponse`) if you are
writing a client for another language and want the shapes to agree.

The protocol itself is documented in [the SDK README](../README.md).

## Troubleshooting

Every problem prints once, not on every beat, so a misconfiguration does not
bury your own logs.

| Message | Meaning |
| --- | --- |
| `no token` | `VIGIL_TOKEN` is not set and none was passed |
| `no project` | `VIGIL_PROJECT_ID` is not set and none was passed |
| `token rejected` | The token is wrong, or was regenerated in the dashboard |
| `this project does not belong to the bot's team` | `VIGIL_PROJECT_ID` points at another team's project |
| `unrecognised Discord client` | Pass the client instance itself, not a wrapper |
| `N shard(s) are over your plan's monitor allowance` | Those shards exist but are not monitored until you upgrade |

Both values are on the bot's page in the dashboard whenever you need them again.

Regenerating a token replaces the old one immediately, with no overlap. That is
deliberate, since a leaked token that keeps working for another hour is not
revoked. Redeploy with the new value and reporting resumes.

## Licence

MIT.

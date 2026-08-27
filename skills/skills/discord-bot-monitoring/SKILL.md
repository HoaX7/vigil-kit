---
name: discord-bot-monitoring
description: Add Vigil per-shard monitoring to a Discord bot. Use when the user asks to monitor their Discord bot, add Vigil to a bot, track shard uptime or gateway latency, or get alerted when their bot or one of its shards goes down.
---

# Monitor a Discord bot with Vigil

Vigil monitors Discord bots per shard: each shard reports its own status,
gateway latency and guild count, and a shard that stops reporting opens an
incident naming that shard alone. Your job is to wire the reporting into the
user's bot.

## Step 1: Detect the language and library

Inspect the project before choosing a path:

- `package.json` with `discord.js` → TypeScript/JavaScript SDK path, zero config.
- `package.json` with another Discord library (`eris`, `oceanic.js`, `detritus`) → SDK path with a custom adapter.
- `requirements.txt`/`pyproject.toml` with `discord.py`/`nextcord`/`py-cord`, or any other language → REST path. A Python SDK is planned but not yet available; say so if the user asks.

## Step 2: Get credentials

The user must add a bot in their Vigil dashboard, which takes a minute and is
the only manual step. Ask them to:

1. Open https://tryvigil.dev/dashboard/new?kind=discord (sign up is free)
2. Create the bot and copy the ready-to-paste env block it shows

That block contains `VIGIL_TOKEN` and `VIGIL_PROJECT_ID`. Put both in the
project's environment the same way its other secrets are handled (`.env` file,
hosting provider config). Never hardcode the token in source. Do not proceed
to verification until the user confirms the values are in place.

## Step 3a: Wire the SDK (Node.js bots)

```bash
npm install @hoax7/vigil-sdk
```

Find where the bot creates its Discord client and add `watch` right after it:

```ts
import { watch } from "@hoax7/vigil-sdk";

// after: const client = new Client({ ... })
watch(client, {
  token: process.env.VIGIL_TOKEN!,
  projectId: process.env.VIGIL_PROJECT_ID!,
});
```

Rules that matter:

- Pass the client instance itself, not a wrapper around it.
- Do not add an interval option. The server sets the cadence from the plan and
  restates it on every response; `intervalSeconds` is accepted and ignored.
- `watch` never throws and never blocks startup, so it is safe at boot. No
  try/catch needed around it.
- Environment names are exactly `VIGIL_TOKEN` and `VIGIL_PROJECT_ID`. The SDK
  also reads them itself, so `watch(client)` with no options works when both
  are set. Optional `VIGIL_URL` overrides the API origin (defaults to
  `https://api.tryvigil.dev`); only set it for local development against a
  local Vigil.

For a non-discord.js library, define an adapter and pass it:

```ts
import { defineAdapter, watch } from "@hoax7/vigil-sdk";

const adapter = defineAdapter({
  library: "eris",
  supports: (c): c is MyClient => "shards" in c,
  create: (client) => ({
    library: "eris",
    shards: () =>
      [...client.shards.values()].map((s) => ({
        id: s.id,
        status: s.ready ? "ready" : "disconnected",
        latencyMs: s.latency,
      })),
    bot: () => ({ shardCount: client.shards.size }),
  }),
});

watch(client, { adapter });
```

`library`, `shards()` and `bot()` are the whole required contract. Full
adapter reference: https://github.com/HoaX7/vigil-sdk/tree/main/ts

## Step 3b: Wire the REST protocol (Python and everything else)

Two calls against `https://api.tryvigil.dev`, both with headers
`Authorization: Bearer <VIGIL_TOKEN>` and `Content-Type: application/json`.

Once, after the bot connects and knows its shard count:

```
POST /v1/handshake
{"project_id": "<VIGIL_PROJECT_ID>", "bot": {"shard_count": 2}}
```

Then on a timer, forever (the handshake and every ingest response carry
`interval_s`; honor it):

```
POST /v1/ingest
{"shards": [
  {"id": 0, "status": "ready", "latency_ms": 42, "guilds": 150},
  {"id": 1, "status": "ready", "latency_ms": 55, "guilds": 143}
]}
```

- `status` is one of `ready`, `resuming`, `idle`, `disconnected`.
- `latency_ms` and `guilds` are optional; send them when the library exposes
  gateway latency and guild counts.
- Report failures by reporting nothing: a shard that misses its deadline is
  marked down server-side. Never let the reporting loop crash the bot; wrap
  it so network errors are logged and retried on the next tick.

discord.py sketch: run the loop as a background task
(`discord.ext.tasks.loop`), read `bot.shard_count`, `bot.latencies` (list of
`(shard_id, latency_seconds)` tuples; multiply by 1000), and start the task in
`setup_hook` or `on_ready`.

## Step 4: Verify

1. Start the bot.
2. Shards appear in the Vigil dashboard automatically on the first connect,
   one monitor each, usually within seconds. Ask the user to check
   https://tryvigil.dev/dashboard/monitors?tab=bots
3. If nothing appears, check the bot's logs. The SDK logs each problem once:

| Log message | Fix |
| --- | --- |
| `no token` | `VIGIL_TOKEN` is not set in the bot's environment |
| `no project` | `VIGIL_PROJECT_ID` is not set |
| `token rejected` | Token is wrong or was regenerated; copy it again from the bot's page |
| `this project does not belong to the bot's team` | `VIGIL_PROJECT_ID` is from another team |
| `unrecognised Discord client` | The client instance was wrapped; pass it directly or use an adapter |
| `N shard(s) are over your plan's monitor allowance` | The plan's monitor limit is smaller than the shard count |

## Notes

- Monitoring alerts (where incidents get sent: email, Discord webhook, Slack)
  are configured in the Vigil dashboard under Alerts, not in code.
- Regenerating the token in the dashboard invalidates the old one immediately;
  redeploy with the new value and reporting resumes.

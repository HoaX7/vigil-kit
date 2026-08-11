# Vigil SDKs

Clients that report a Discord bot's shards to Vigil.

| Language | Package | Status |
| --- | --- | --- |
| TypeScript | [`@hoax7/vigil-sdk`](./ts) | available |
| Python | `vigil-discord` | planned |
| Rust | `vigil-discord` | planned |

Every client does the same three things: read shard state from the Discord
library's client object, POST it on a timer, and never throw into the host
process. The protocol below is the contract. The clients are thin.

## Why push

A sharded bot cannot be probed. There is no endpoint to reach and the gateway
state lives in the bot's own memory, so the bot reports and the absence of a
report is the failure signal. Nothing in a client decides that a shard is down.

## Protocol

Two calls. A handshake on connect, then a heartbeat on a timer.

Both authenticate with a bot token issued in the Vigil dashboard:

```
Authorization: Bearer vgl_<prefix>_<secret>
Content-Type: application/json
```

### POST /v1/handshake

Registers the bot and provisions one monitor per shard. Sent on every connect,
not only the first, and handled as an upsert, so a bot that restarts fifty times
a day does not accumulate fifty copies of shard 0.

```jsonc
{
  "project_id": "…",
  "bot": {
    "id": "1234",
    "application_id": "1234",
    "username": "acme-bot",
    "shard_count": 16
  },
  "shards": [
    { "id": 0, "guilds": ["9876…", "9877…"] }
  ],
  "sdk": { "name": "@hoax7/vigil-sdk", "version": "0.1.0", "runtime": "node/25.1.0" }
}
```

`project_id` comes from your configuration, so your shards land in whatever
project structure you already use. An unknown project is rejected rather than
created.

Guild ids travel here because this is the one moment a client holds the complete
set. They are validated and currently discarded: the guild lookup on a status
page is arithmetic on the snowflake, so nothing needs them stored. They are in
the format from the start because a released client cannot gain a field later.

### POST /v1/ingest

```jsonc
{
  "sent_at": "2026-08-03T14:22:07.123Z",
  "shards": [
    {
      "id": 7,
      "status": "ready",
      "latency_ms": 71,
      "guilds": 3914,
      "last_ready_at": "…",
      "disconnects": 0,
      "resumes": 0
    }
  ],
  "process": { "rss_bytes": 402653184, "uptime_s": 84210 },
  "events": [
    { "kind": "shard_disconnect", "shard_id": 7, "close_code": 4004,
      "message": "authentication failed", "at": "…" }
  ],
  "guilds": {
    "added":   [{ "shard_id": 3, "id": "9902…" }],
    "removed": [{ "shard_id": 3, "id": "9903…" }]
  }
}
```

`shards` is the only required field. Everything else is optional so a client can
ship before it reaches parity.

`status` is one of `ready`, `disconnected`, `resuming` or `idle`. Only `ready`
counts as up. A shard that is ready but slower than the monitor's threshold is
recorded as degraded, which the server decides, not the client.

### Response

Both calls answer with the same envelope:

```jsonc
{ "ok": true, "interval_s": 15, "accepted": 10, "suspended_shards": [10, 11, 12] }
```

`interval_s` is the cadence to beat at. The server owns it so it can change
without anyone redeploying a bot.

`suspended_shards` are shards over the team's monitor allowance. They exist and
are visible in the dashboard, but no heartbeat is recorded for them. A client
should say so once rather than leave the operator wondering about a gap.

### Status codes

| Code | Meaning | What a client does |
| --- | --- | --- |
| 200 | Recorded | Continue |
| 400 | Malformed payload | Log once. This is a client bug |
| 401 | Token wrong or regenerated | Log once, keep retrying quietly |
| 403 | Project belongs to another team | Log once |
| 409 | No shards registered | Handshake, then retry |
| 413 | Body over 256 KB | Log once |
| 429 | Rate limited | Back off |
| 5xx, no response | Transient | Back off and retry |

## Rules for a client

These are what make a client safe to install in someone else's production bot.

**Fail silent.** Network errors, our downtime, a 500, a wrong token: every one
is swallowed and retried with backoff. A monitoring SDK that can crash the thing
it monitors is a liability.

**Never read the bot token.** A client takes the library's client object and
reads shard state from it. Nothing else. This has to be true and has to be
evident from what the code does.

**Outbound only.** No inbound connection and no port to open, so it works behind
NAT with no configuration.

**Optional dependency.** The Discord library is a peer dependency reached
through duck typed access, never a hard requirement.

**Retry with jitter.** A large cluster restarting after an incident must not
retry in lockstep, which is the shape that keeps an outage going.

**Queue events, do not spend requests on them.** Gateway events arrive whenever
Discord feels like it. They ride along with the next beat, and survive a failed
send so a disconnect is not lost precisely when it explains the outage.

**Filter unavailable guilds.** Discord fires a guild delete when a guild has an
outage and again when it recovers, neither of which means the bot left. Only a
delete with `unavailable` absent or false is a real removal.

## Licence

MIT.

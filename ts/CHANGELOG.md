# Changelog

Notable changes per release. Patch = fixes, minor = new capability (including
new optional adapter members), major = breaking.

## 0.1.0

- First public release.
- `watch(client)` reports every shard: status, gateway latency, guild count,
  and the gateway events that explain a failure.
- discord.js supported out of the box; anything else through a passed-in
  adapter (`defineAdapter`), with no global registry.
- Server-controlled heartbeat cadence; `intervalSeconds` accepted and ignored.
- Never throws into the host bot: bad config, bad adapter and Vigil outages
  degrade to a log line.

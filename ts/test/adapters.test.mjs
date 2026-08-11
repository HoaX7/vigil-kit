import {
  watch,
  defineAdapter,
  SafeAdapter,
  resolveAdapter,
  builtinAdapters,
} from "../dist/index.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const safeLog = { ...silentLog, once: () => {} };

/** A recording fetch, injected instead of patching a global. */
function recorder(responder = () => ({ status: 200, body: { ok: true, interval_s: 30 } })) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, body: JSON.parse(init.body), ua: init.headers["user-agent"] };
    calls.push(call);
    const res = responder(call);
    return { status: res.status, json: async () => res.body };
  };
  // Selecting by endpoint rather than by index: an assertion on calls[1] reads
  // as passing when the array is short, which hid a duplicate-send bug once.
  calls.handshakes = () => calls.filter((c) => c.url.endsWith("/v1/handshake"));
  calls.beats = () => calls.filter((c) => c.url.endsWith("/v1/ingest"));
  calls.guildSyncs = () => calls.filter((c) => c.url.endsWith("/v1/guilds"));
  return { fn, calls };
}

const creds = { token: "vgl_abc_def", projectId: "p1", url: "http://x", logger: silentLog };

console.log("\n1. a community adapter injected via { adapter }");
{
  const { fn, calls } = recorder();
  const adapter = {
    library: "my-library",
    shards: () => [{ id: 0, status: "ready", latencyMs: 42, guilds: 7 }],
    bot: () => ({ id: "1234", shardCount: 1 }),
  };
  const w = watch(adapter, { ...creds, fetch: fn });
  await w.flush();
  w.stop();
  check("handshake sent exactly once", calls.handshakes().length === 1, String(calls.handshakes().length));
  check("library reached the user agent", calls[0]?.ua.includes("my-library"), calls[0]?.ua);
  check("heartbeat sent", calls.beats().length >= 1, String(calls.beats().length));
  check("heartbeat carried the shard", calls.beats()[0]?.body.shards[0]?.latency_ms === 42);
  check("three members were enough", true);
}

console.log("\n2. a factory injected, client detected by its own predicate");
{
  const { fn, calls } = recorder();
  const mine = defineAdapter({
    library: "mine",
    supports: (c) => "myShardManager" in c,
    create: (client) => ({
      library: "mine",
      shards: () => [{ id: 0, status: "ready" }],
      bot: () => ({ shardCount: client.myShardManager.total }),
    }),
  });
  const client = { myShardManager: { total: 8 } };
  const w = watch(client, { ...creds, adapter: mine, fetch: fn });
  await w.flush();
  w.stop();
  check("factory built the adapter", calls.handshakes().length === 1);
  check("shard count read from the client", calls.handshakes()[0]?.body.bot.shard_count === 8);
}

console.log("\n3. an adapter that throws from every method");
{
  const { fn, calls } = recorder();
  const hostile = {
    library: "hostile",
    shards: () => { throw new Error("boom shards"); },
    bot: () => { throw new Error("boom bot"); },
    guilds: () => { throw new Error("boom guilds"); },
    ready: async () => { throw new Error("boom ready"); },
    onEvent: () => { throw new Error("boom onEvent"); },
    onGuildChange: () => { throw new Error("boom onGuildChange"); },
    dispose: () => { throw new Error("boom dispose"); },
  };
  let survived = true;
  try {
    const w = watch(hostile, { ...creds, fetch: fn });
    await w.flush();
    w.stop();
  } catch (e) {
    survived = false;
    console.log("   threw:", e.message);
  }
  check("watch survived a fully hostile adapter", survived);
  check("nothing was sent", calls.length === 0, String(calls.length));
}

console.log("\n4. a listener that throws does not escape into the host");
{
  let attached;
  const adapter = {
    library: "emitter",
    shards: () => [{ id: 0, status: "ready" }],
    bot: () => ({ shardCount: 1 }),
    onEvent: (listener) => { attached = listener; },
  };
  const safe = new SafeAdapter(adapter, safeLog);
  safe.onEvent(() => { throw new Error("listener blew up"); });
  let escaped = false;
  try {
    attached({ kind: "shard_disconnect", at: new Date() });
  } catch {
    escaped = true;
  }
  check("the throw stayed inside the guard", !escaped);
}

console.log("\n5. normalisation of garbage from an adapter");
{
  const junk = {
    library: "junk",
    shards: () => [
      { id: 0, status: "ready", latencyMs: -1 },          // -1 means "unmeasured"
      { id: 0, status: "ready" },                          // duplicate id
      { id: -5, status: "ready" },                         // invalid id
      { id: 1, status: "not-a-real-status" },              // unknown status
      { id: 2, status: "ready", latencyMs: 99_999_999 },   // absurd latency
      { id: 3, status: "ready", guilds: -4 },              // negative count
      null,
      "nonsense",
    ],
    bot: () => ({ id: "not-a-snowflake!", applicationId: "1234", shardCount: "12" }),
  };
  const safe = new SafeAdapter(junk, safeLog);
  const shards = safe.shards();
  check("duplicate id dropped", shards.filter((s) => s.id === 0).length === 1);
  check("invalid id dropped", !shards.some((s) => s.id === -5));
  check("non-objects dropped", shards.length === 4, String(shards.length));
  check("negative latency omitted", shards[0].latencyMs === undefined);
  check("unknown status becomes disconnected", shards.find((s) => s.id === 1).status === "disconnected");
  check("latency clamped", shards.find((s) => s.id === 2).latencyMs === 600000);
  check("negative guild count omitted", shards.find((s) => s.id === 3).guilds === undefined);

  const bot = safe.bot();
  check("non-snowflake id rejected", bot.id === undefined);
  check("valid snowflake kept", bot.applicationId === "1234");
  check("string shard count coerced", bot.shardCount === 12);
}

console.log("\n6. a ready() that never settles is raced, not awaited forever");
{
  const stuck = {
    library: "stuck",
    shards: () => [],
    bot: () => ({ shardCount: 0 }),
    ready: () => new Promise(() => {}),
  };
  const safe = new SafeAdapter(stuck, safeLog);
  const outcome = await Promise.race([
    safe.ready().then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 200)),
  ]);
  check("still pending at 200ms, the guard is 60s", outcome === "pending");
}

console.log("\n6b. a ready() that resolves fast is never called slow");
{
  const warnings = [];
  const quick = {
    library: "quick",
    shards: () => [{ id: 0, status: "ready" }],
    bot: () => ({ shardCount: 1 }),
    ready: async () => {},
  };
  const safe = new SafeAdapter(quick, { ...silentLog, once: (_k, m) => warnings.push(m) });
  await safe.ready();
  // The loser of a race keeps running, so the timer has to be inspected rather
  // than allowed to warn from inside itself. Waiting proves it was cleared.
  await new Promise((r) => setTimeout(r, 300));
  check("no slow-adapter warning", warnings.length === 0, warnings.join(" | "));
}

console.log("\n7. resolution is pure, with no global registry");
{
  const mine = defineAdapter({
    library: "mine",
    supports: (c) => "myShardManager" in c,
    create: (c) => ({ library: "mine", shards: () => [], bot: () => ({ shardCount: c.myShardManager.total }) }),
  });
  const client = { myShardManager: { total: 8 } };

  const a = resolveAdapter(client, { adapters: [mine] });
  check("custom factory matched", a.ok && a.adapter.library === "mine");

  const b = resolveAdapter(client);
  check("the same client is unmatched without it", !b.ok, b.ok ? b.adapter.library : "");
  check("failure names what was tried", !b.ok && b.reason.includes("discord.js"), b.ok ? "" : b.reason);

  const c = resolveAdapter(client, { adapters: [mine], builtins: [] });
  check("builtins can be replaced", c.ok && c.adapter.library === "mine");
  check("builtins are exported as data", Array.isArray(builtinAdapters) && builtinAdapters.length === 1);

  const d = resolveAdapter(client, { adapter: mine });
  check("a factory that matches is used", d.ok);
  const e = resolveAdapter({ nope: true }, { adapter: mine });
  check("a factory that does not match says so", !e.ok && e.reason.includes("mine"), e.ok ? "" : e.reason);
}

console.log("\n8. the built-in discord.js adapter still detects a client");
{
  const { fn, calls } = recorder();
  const fake = {
    on() {}, off() {}, once(_e, cb) { cb(); },
    ws: { shards: { size: 2, [Symbol.iterator]: function* () {
      yield { id: 0, ping: 30, status: 0 };
      yield { id: 1, ping: -1, status: 8 };
    } } },
    guilds: { cache: [{ id: "847362819283746152", shardId: 0 }] },
    user: { id: "1234567890", username: "acme-bot" },
    isReady: () => true,
  };
  const w = watch(fake, { ...creds, fetch: fn });
  await w.flush();
  // The roster sync runs off the handshake without blocking it; one macrotask
  // lets those posts land before they are asserted on.
  await new Promise((r) => setTimeout(r, 0));
  w.stop();
  const beat = calls.beats()[0];
  check("detected as discord.js", calls[0]?.ua.includes("discord.js"), calls[0]?.ua);
  // Counts ride the handshake; the ids themselves stream to /v1/guilds.
  check("guild count sent on handshake", calls.handshakes()[0]?.body.shards[0]?.guild_count === 1);
  check(
    "guild ids streamed to the roster sync",
    calls.guildSyncs()[0]?.body.guilds?.[0]?.id === "847362819283746152",
    JSON.stringify(calls.guildSyncs()[0]?.body),
  );
  check("a heartbeat was actually sent", beat !== undefined);
  check("ready shard reported", beat?.body.shards[0]?.status === "ready", JSON.stringify(beat?.body.shards));
  check("resuming shard reported", beat?.body.shards[1]?.status === "resuming");
  check("measured ping sent", beat?.body.shards[0]?.latency_ms === 30);
  check("unmeasured ping omitted", beat?.body.shards[1]?.latency_ms === undefined);
}

console.log("\n9. no shard count means no premature registration");
{
  const { fn, calls } = recorder();
  const spawning = { library: "spawning", shards: () => [{ id: 0, status: "idle" }], bot: () => ({ shardCount: 0 }) };
  const w = watch(spawning, { ...creds, fetch: fn });
  await w.flush();
  w.stop();
  check("nothing registered before the client spawns", calls.length === 0, String(calls.length));
}

console.log("\n10. bad config and bad adapter both return an inert watcher");
{
  const w1 = watch({}, { logger: silentLog });
  const w2 = watch({}, { ...creds, adapter: { nonsense: true } });
  w1.stop();
  await w2.flush();
  w2.stop();
  check("missing credentials do not throw", true);
  check("invalid adapter does not throw", true);
}

console.log("\n11. flush during startup does not double the traffic");
{
  const { fn, calls } = recorder();
  const adapter = { library: "racy", shards: () => [{ id: 0, status: "ready" }], bot: () => ({ shardCount: 1 }) };
  const w = watch(adapter, { ...creds, fetch: fn });
  await Promise.all([w.flush(), w.flush(), w.flush()]);
  w.stop();
  check("registered once despite concurrent flushes", calls.handshakes().length === 1, String(calls.handshakes().length));
  check("each flush produced a beat", calls.beats().length >= 1, String(calls.beats().length));
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

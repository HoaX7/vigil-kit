import { defineAdapter, watch, type ShardAdapter, type ShardState } from "../src/index.js";

interface MyClient {
  shardManager: { total: number; each(): Array<{ index: number; alive: boolean; rtt: number }> };
}

const myAdapter = defineAdapter({
  library: "my-library",
  supports: (c): c is MyClient => "shardManager" in c,
  create: (client) => ({
    library: "my-library",
    // `client` must be MyClient here with no cast and no annotation.
    shards: (): ShardState[] =>
      client.shardManager.each().map((s) => ({
        id: s.index,
        status: s.alive ? "ready" : "disconnected",
        latencyMs: s.rtt,
      })),
    bot: () => ({ shardCount: client.shardManager.total }),
  }),
});

declare const client: MyClient;
watch(client, { adapter: myAdapter });

// A hand-written adapter satisfies the interface with three members.
const minimal: ShardAdapter = {
  library: "minimal",
  shards: () => [{ id: 0, status: "ready" }],
  bot: () => ({ shardCount: 1 }),
};
watch(minimal);

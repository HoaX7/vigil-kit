/**
 * The ingest wire format, mirrored from the server contract.
 *
 * Every field the server may one day read is present and optional. A published
 * SDK version keeps speaking the shape it shipped with, so this file grows and
 * never changes meaning.
 */

export type ShardStatus = "ready" | "disconnected" | "resuming" | "idle";

export interface ShardState {
  id: number;
  status: ShardStatus;
  /** Gateway heartbeat round trip. Absent until the first heartbeat lands. */
  latencyMs?: number;
  guilds?: number;
  lastReadyAt?: Date;
}

export interface BotInfo {
  id?: string;
  applicationId?: string;
  username?: string;
  shardCount: number;
}

export interface SdkEvent {
  kind: "shard_disconnect" | "shard_reconnect" | "shard_ready" | "shard_resume" | "error" | "warn";
  level?: "info" | "warn" | "error";
  shardId?: number;
  message?: string;
  stack?: string;
  closeCode?: number;
  at: Date;
}

export interface GuildDelta {
  shardId: number;
  id: string;
  name?: string | undefined;
}

/** What both endpoints answer with. */
export interface IngestResponse {
  ok: boolean;
  /** The cadence to beat at. The server owns it; the client obeys. */
  interval_s?: number;
  accepted?: number;
  suspended_shards?: number[];
  error?: string;
  /** On a 429: seconds until the next beat will be accepted. */
  retry_after_s?: number;
  /** Set to "handshake" when the server wants a fresh registration. */
  action?: string;
}

// ---- wire format ----
//
// What actually goes over HTTP, as opposed to the shapes an adapter works in.
// Exported so a client written against this protocol in another language, or a
// test asserting on a request body, has the same names to refer to.

export interface WireShardBeat {
  id: number;
  status: ShardStatus;
  latency_ms?: number | undefined;
  guilds?: number | undefined;
  last_ready_at?: string | undefined;
}

export interface WireEvent {
  kind: string;
  level?: string | undefined;
  shard_id?: number | undefined;
  message?: string | undefined;
  stack?: string | undefined;
  close_code?: number | undefined;
  at: string;
}

export interface WireGuildDelta {
  shard_id: number;
  id: string;
  name?: string | undefined;
}

export interface HandshakePayload {
  project_id: string;
  bot: {
    id?: string | undefined;
    application_id?: string | undefined;
    username?: string | undefined;
    shard_count: number;
  };
  /** Counts only. The roster itself streams in chunks on /v1/guilds. */
  shards: Array<{ id: number; guild_count: number }>;
  sdk: { name: string; version: string; runtime: string };
}

export interface HeartbeatPayload {
  sent_at: string;
  shards: WireShardBeat[];
  process?: {
    rss_bytes?: number | undefined;
    uptime_s?: number | undefined;
  };
  events?: WireEvent[];
  guilds?: {
    added?: WireGuildDelta[];
    removed?: WireGuildDelta[];
  };
}

/** One chunk of a shard's roster, sent after a successful handshake. */
export interface GuildsSyncPayload {
  shard_id: number;
  page: number;
  guilds: Array<{ id: string; name?: string | undefined }>;
}

/** Any body the ingest endpoints accept. */
export type IngestPayload = HandshakePayload | HeartbeatPayload | GuildsSyncPayload;

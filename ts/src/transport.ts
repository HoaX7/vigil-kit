import type { Config, FetchLike } from "./config.js";
import type { IngestPayload, IngestResponse } from "./types.js";

export interface TransportResult {
  status: number;
  body: IngestResponse | null;
}

const TIMEOUT_MS = 10_000;

/**
 * One POST, with a deadline and no opinions about what to do next.
 *
 * Nothing here throws. A network failure, a DNS failure and a 500 all come back
 * as a status the caller decides about, because the one behaviour this SDK can
 * never have is taking down the process it is watching.
 */
export class Transport {
  /** Injected, so a test or a proxy can stand in without patching a global. */
  private readonly send: FetchLike;

  constructor(
    private readonly config: Config,
    private readonly userAgent: string,
  ) {
    this.send = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async post(path: string, payload: IngestPayload): Promise<TransportResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.send(`${this.config.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
          "user-agent": this.userAgent,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { status: res.status, body: await readJson(res) };
    } catch {
      // Unreachable, refused, aborted, offline. Status 0 means "we never got an
      // answer", which the caller retries rather than acts on.
      return { status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readJson(res: Response): Promise<IngestResponse | null> {
  try {
    return (await res.json()) as IngestResponse;
  } catch {
    return null;
  }
}

/**
 * Exponential backoff with jitter, capped.
 *
 * The jitter matters more than the curve: a large bot cluster restarting after
 * an incident would otherwise retry in lockstep and arrive as a spike every
 * time, which is the shape that keeps an outage going.
 */
export function backoffDelay(attempt: number, baseMs = 1_000, capMs = 60_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

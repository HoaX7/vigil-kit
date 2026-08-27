import { hostname } from "node:os";
import { apiUrl, token } from "./config.js";

declare const __VIGIL_VERSION__: string;

/**
 * Identifies this device in the session the login mints, so the dashboard's
 * Devices page can say "Vigil CLI on macOS (hostname)" instead of "Browser".
 */
function userAgent(): string {
  const version = typeof __VIGIL_VERSION__ === "string" ? __VIGIL_VERSION__ : "dev";
  let host = "";
  try {
    host = hostname();
  } catch {
    host = "";
  }
  return `vigil-cli/${version} (${process.platform}; ${process.arch}${host ? `; ${host}` : ""})`;
}

export class CliError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** A misused command: the error is followed by that command's help page. */
export class UsageError extends CliError {}

export interface NetObserver {
  begin(label: string): void;
  end(): void;
}

let observer: NetObserver = { begin: () => {}, end: () => {} };

export function setNetObserver(obs: NetObserver): void {
  observer = obs;
}

async function observed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  observer.begin(label);
  try {
    return await fn();
  } finally {
    observer.end();
  }
}

function authHeaders(): Record<string, string> {
  const t = token();
  if (t === "") {
    throw new CliError("Not logged in. Run: vigil login", "UNAUTHORIZED");
  }
  return { Authorization: `Bearer ${t}`, "Content-Type": "application/json", "User-Agent": userAgent() };
}

interface TrpcEnvelope {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
}

async function parse(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => ({}))) as TrpcEnvelope;
  if (body.error) {
    const code = body.error.data?.code;
    if (code === "UNAUTHORIZED") {
      throw new CliError("Session expired or invalid. Run: vigil login", code);
    }
    throw new CliError(body.error.message ?? `request failed (${res.status})`, code);
  }
  if (!res.ok) throw new CliError(`request failed (${res.status})`);
  return body.result?.data;
}

export function trpcQuery(path: string, input?: unknown): Promise<unknown> {
  return observed(`${path}…`, async () => {
    const qs = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await fetch(`${apiUrl()}/trpc/${path}${qs}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    return parse(res);
  });
}

export function trpcMutation(path: string, input?: unknown): Promise<unknown> {
  return observed(`${path}…`, async () => {
    const res = await fetch(`${apiUrl()}/trpc/${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(input ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    return parse(res);
  });
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export function requestDeviceCode(api: string): Promise<DeviceCodeResponse> {
  return observed("Contacting Vigil…", () => requestDeviceCodeInner(api));
}

async function requestDeviceCodeInner(api: string): Promise<DeviceCodeResponse> {
  const res = await fetch(`${api}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify({ client_id: "vigil-cli" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new CliError(`could not start login (${res.status}). Check the API URL: ${api}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

export type PollResult =
  | { status: "ok"; token: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "failed"; reason: string };

export async function pollDeviceToken(api: string, deviceCode: string): Promise<PollResult> {
  const res = await fetch(`${api}/api/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: "vigil-cli",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (body.access_token) return { status: "ok", token: body.access_token };
  if (body.error === "authorization_pending") return { status: "pending" };
  if (body.error === "slow_down") return { status: "slow_down" };
  return { status: "failed", reason: body.error_description ?? body.error ?? `login failed (${res.status})` };
}

export async function signOut(): Promise<void> {
  const t = token();
  if (t === "") return;
  await fetch(`${apiUrl()}/api/auth/sign-out`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", "User-Agent": userAgent() },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

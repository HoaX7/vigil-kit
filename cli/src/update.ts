import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./http.js";
import { log, say } from "./output.js";
import { step, trackStep } from "./ui.js";

export const INSTALL_URL = process.env["VIGIL_CLI_URL"] || "https://cli.tryvigil.dev";

/** Positive when a is newer than b. Plain numeric semver, no prereleases. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchLatest(timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`${INSTALL_URL}/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" && /^\d+\.\d+\.\d+$/.test(data.version) ? data.version : null;
  } catch {
    return null;
  }
}

const CHECK_FILE = join(homedir(), ".vigil", "update-check.json");
const CHECK_EVERY_MS = 24 * 60 * 60_000;

interface CheckCache {
  at: string;
  latest: string;
}

function readCache(): CheckCache | null {
  try {
    return JSON.parse(readFileSync(CHECK_FILE, "utf8")) as CheckCache;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    mkdirSync(join(homedir(), ".vigil"), { recursive: true, mode: 0o700 });
    writeFileSync(CHECK_FILE, JSON.stringify({ at: new Date().toISOString(), latest } satisfies CheckCache) + "\n");
  } catch {
    /* a failed cache write never blocks a command */
  }
}

/**
 * After a normal command: at most once a day, learn the latest version, and
 * mention a newer one on stderr. Never delays a command by more than the
 * short fetch timeout, and only speaks on an interactive terminal.
 */
export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  if (!process.stderr.isTTY) return;
  const cache = readCache();
  let latest = cache?.latest ?? null;
  const stale = !cache || Date.now() - new Date(cache.at).getTime() > CHECK_EVERY_MS;
  if (stale) {
    latest = await fetchLatest(1500);
    if (latest) writeCache(latest);
  }
  if (latest && compareSemver(latest, currentVersion) > 0) {
    log(`A new version of vigil is available (${currentVersion} -> ${latest}). Run: vigil update`);
  }
}

export async function update(currentVersion: string): Promise<void> {
  const latest = await step("Checking for updates…", async () => {
    const v = await fetchLatest(10_000);
    if (!v) throw new CliError(`Could not reach ${INSTALL_URL} to check the latest version. Try again.`);
    return v;
  });

  if (compareSemver(latest, currentVersion) <= 0) {
    writeCache(latest);
    say(`Already on the latest version (${currentVersion}).`);
    return;
  }

  const output = await trackStep(`Updating vigil ${currentVersion} -> ${latest}…`, () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn("sh", ["-c", `curl -fsSL ${INSTALL_URL} | sh`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, VIGIL_UPDATE: "1" },
      });
      let text = "";
      child.stdout?.on("data", (d: Buffer) => (text += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (text += d.toString()));
      child.on("exit", (code) => (code === 0 ? resolve(text.trim()) : reject(new CliError(text.trim() || "update failed"))));
      child.on("error", () => reject(new CliError(`update failed. Run: curl -fsSL ${INSTALL_URL} | sh`)));
    }),
  );

  writeCache(latest);
  say(output || `Updated vigil to ${latest}`);
}

import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  api_url: string;
  token: string;
  user?: { email?: string; name?: string };
  saved_at: string;
}

export const DEFAULT_API_URL = "https://api.tryvigil.dev";

const dir = join(homedir(), ".vigil");
const file = join(dir, "config.json");

export function loadConfig(): CliConfig | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliConfig;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: CliConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearConfig(): void {
  rmSync(file, { force: true });
}

export function apiUrl(): string {
  return process.env["VIGIL_API_URL"] || loadConfig()?.api_url || DEFAULT_API_URL;
}

export function token(): string {
  return process.env["VIGIL_TOKEN"] || loadConfig()?.token || "";
}

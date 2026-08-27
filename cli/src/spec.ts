import { readFileSync } from "node:fs";
import { str, type Parsed } from "./args.js";
import { CliError } from "./http.js";

/** Reads a JSON body from a file, or stdin when the path is "-". */
export function readSpec(spec: string): Record<string, unknown> {
  const raw = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliError("--spec must be valid JSON");
  }
}

/** The --spec body a command requires. */
export function specOf(p: Parsed): Record<string, unknown> {
  const path = str(p.flags, "spec");
  if (!path) throw new CliError("This command takes --spec <file|-> with a JSON body. See vigil --help.");
  return readSpec(path);
}

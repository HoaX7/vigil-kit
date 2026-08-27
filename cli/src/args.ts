export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

export function str(flags: Parsed["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function num(flags: Parsed["flags"], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

export function csv(flags: Parsed["flags"], key: string): string[] | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function bool(flags: Parsed["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

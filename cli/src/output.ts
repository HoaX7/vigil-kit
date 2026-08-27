export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function log(line: string): void {
  process.stderr.write(line + "\n");
}

export function say(line: string): void {
  process.stdout.write(line + "\n");
}

export function table(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) {
    say("(none)");
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ");
  say(line(columns.map((c) => c.toUpperCase())));
  for (const r of rows) say(line(columns.map((c) => String(r[c] ?? ""))));
}

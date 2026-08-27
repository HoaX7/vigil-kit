export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function log(line: string): void {
  process.stderr.write(line + "\n");
}

export function say(line: string): void {
  process.stdout.write(line + "\n");
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * Table with the preferred columns that actually occur in the data, falling
 * back to the first few scalar keys, so any list renders readably without a
 * bespoke formatter.
 */
export function autoTable(rows: Record<string, unknown>[], preferred: string[]): void {
  if (rows.length === 0) {
    say("(none)");
    return;
  }
  let columns = preferred.filter((c) => rows.some((r) => r[c] !== undefined && r[c] !== null));
  if (columns.length === 0) {
    const first = rows[0] ?? {};
    columns = Object.keys(first)
      .filter((k) => typeof first[k] !== "object" || first[k] === null)
      .slice(0, 5);
  }
  table(
    rows.map((r) => Object.fromEntries(columns.map((c) => [c, cell(r[c])]))),
    columns,
  );
}

/** Key/value block for one record: scalars and short lists, nested kept terse. */
export function renderKV(value: unknown): void {
  if (value === null || value === undefined) {
    say("(nothing)");
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    say(cell(value));
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const width = Math.min(
    Math.max(...keys.map((k) => k.length), 1),
    28,
  );
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v) && v.every((e) => typeof v !== "object" || e === null || typeof e !== "object")) {
      say(`${k.padEnd(width)}  ${v.map(cell).join(", ")}`);
    } else {
      say(`${k.padEnd(width)}  ${cell(v)}`);
    }
  }
}

/** "Showing 1 to 25 of 240. Next page: --offset 25" under a paged table. */
export function pagerLine(offset: number, shown: number, total: number): string | null {
  if (total <= shown && offset === 0) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const next = to < total ? ` Next page: --offset ${to}` : "";
  return `Showing ${from} to ${to} of ${total}.${next}`;
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

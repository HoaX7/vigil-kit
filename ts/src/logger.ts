/**
 * The SDK's log line: `[vigil][2026-08-05 15:03:12.446] [INFO] message`.
 *
 * Console only, by design: this code runs inside someone else's bot process,
 * where a log framework, a transport or a file would be an imposition. Anyone
 * with opinions brings their own logger via `{ logger }` and receives the raw
 * message per level, not our formatting, because their sink already has
 * timestamps and prefixes of its own.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The BYO surface: anything with these methods can replace the console. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

const PREFIX = "[vigil]";

const CONSOLE: Record<LogLevel, (line: string) => void> = {
  debug: (l) => console.debug(l),
  info: (l) => console.log(l),
  warn: (l) => console.warn(l),
  error: (l) => console.error(l),
};

/** Local wall-clock time, `2026-08-05 15:03:12.446`: these lines are read
    live in a terminal, where UTC is a subtraction nobody wants to do. */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

export class SdkLogger implements Required<Logger> {
  /**
   * Keys already said. The failure modes here repeat on a timer: a wrong
   * token would otherwise print the same line every beat for as long as the
   * bot runs, which buries the log the operator actually needs to read.
   */
  private readonly seen = new Set<string>();

  constructor(
    private readonly silent: boolean,
    private readonly custom?: Logger,
  ) {}

  /** Every level funnels through here; this is the one place that formats. */
  private write(level: LogLevel, message: string): void {
    if (this.silent) return;
    if (this.custom) {
      const method = level === "debug" ? (this.custom.debug ?? this.custom.info) : this.custom[level];
      method.call(this.custom, message);
      return;
    }
    CONSOLE[level](`${PREFIX}[${stamp()}] [${level.toUpperCase()}] ${message}`);
  }

  debug(message: string): void {
    this.write("debug", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  once(key: string, message: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.write("warn", message);
  }
}

export function createLogger(silent: boolean, custom?: Logger): SdkLogger {
  return new SdkLogger(silent, custom);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/**
 * One spinner for the whole process, writing to stderr so stdout stays pure
 * data. Animates only on a TTY; piped output (agents, CI) sees nothing.
 */
class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private readonly tty = process.stderr.isTTY === true;

  start(label: string): void {
    this.label = label;
    if (!this.tty || this.timer) {
      this.render();
      return;
    }
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
    this.timer.unref();
    this.render();
  }

  update(label: string): void {
    this.label = label;
    this.render();
  }

  /** Clears the line; a final note prints as a normal log line. */
  stop(note?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty) {
      process.stderr.write("\r\x1b[2K");
      if (note) process.stderr.write(note + "\n");
    }
    this.label = "";
  }

  active(): boolean {
    return this.timer !== null;
  }

  private render(): void {
    if (!this.tty || !this.timer) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    process.stderr.write(`\r\x1b[2K${FRAMES[this.frame]} ${this.label}`);
  }
}

export const progress = new Progress();

/** Runs one labelled unit of work under the spinner. */
export async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  progress.start(label);
  try {
    const result = await fn();
    progress.stop();
    return result;
  } catch (err) {
    progress.stop();
    throw err;
  }
}

/**
 * Network hooks for the http layer: any request without an explicit step
 * around it still gets a spinner, labelled by its procedure. Overlapping
 * requests (Promise.all) share the spinner and it stops with the last one.
 */
let inFlight = 0;
let explicitSteps = 0;

export function trackStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  explicitSteps++;
  return step(label, fn).finally(() => {
    explicitSteps--;
  });
}

export const netHooks = {
  begin(label: string): void {
    inFlight++;
    if (explicitSteps > 0) return;
    if (progress.active()) progress.update(label);
    else progress.start(label);
  },
  end(): void {
    inFlight = Math.max(0, inFlight - 1);
    if (explicitSteps > 0) return;
    if (inFlight === 0) progress.stop();
  },
};

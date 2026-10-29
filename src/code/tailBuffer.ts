// Output lines collected inside a worker during a run, bounded: past `cap` characters the oldest
// lines are dropped and the text starts with a "… (truncated)" marker, so a tight print loop cannot
// exhaust the worker's memory before the time budget ends the run.

/** Characters a worker keeps per stream (the runtime keeps a smaller tail of it). */
export const WORKER_STREAM_CAP = 200_000;
export const TRUNCATED_MARK = "… (truncated)";

export class TailBuffer {
  private lines: string[] = [];
  private head = 0;
  private size = 0;
  private truncated = false;
  private readonly cap: number;

  constructor(cap = WORKER_STREAM_CAP) {
    this.cap = cap;
  }

  push(line: string): void {
    this.lines.push(line);
    this.size += line.length + 1;
    if (this.size <= this.cap) return;
    while (this.size > this.cap && this.head < this.lines.length - 1) {
      this.size -= this.lines[this.head].length + 1;
      this.head++;
      this.truncated = true;
    }
    // Compact now and then so dropped lines are freed.
    if (this.head > 1024 && this.head * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }

  /** The kept lines, newline-terminated ("" when nothing was pushed). */
  text(): string {
    const kept = this.lines.slice(this.head);
    if (kept.length === 0) return "";
    return `${this.truncated ? `${TRUNCATED_MARK}\n` : ""}${kept.join("\n")}\n`;
  }
}

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  tMs: number;
  level: LogLevel;
  source: string;
  message: string;
  /** Market window start (unix sec) when the line was emitted. */
  windowStart?: number;
}

type LogListener = (entry: LogEntry) => void;

class LogService {
  private readonly buffer: LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();
  private currentWindowStart: number | null = null;
  private previousWindowStart: number | null = null;

  info(source: string, message: string): void {
    this.emit("info", source, message);
  }

  success(source: string, message: string): void {
    this.emit("success", source, message);
  }

  warn(source: string, message: string): void {
    this.emit("warn", source, message);
  }

  error(source: string, message: string): void {
    this.emit("error", source, message);
  }

  /** Track display window rolls — buffer keeps current + previous window only. */
  setActiveWindow(windowStart: number): void {
    if (!Number.isFinite(windowStart) || windowStart <= 0) return;
    if (this.currentWindowStart === windowStart) return;
    this.previousWindowStart = this.currentWindowStart;
    this.currentWindowStart = windowStart;
    this.pruneBuffer();
  }

  getRecent(): LogEntry[] {
    return [...this.buffer];
  }

  onEntry(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private isWindowKept(windowStart?: number): boolean {
    if (this.currentWindowStart == null) return true;
    if (windowStart == null) return false;
    return (
      windowStart === this.currentWindowStart || windowStart === this.previousWindowStart
    );
  }

  private pruneBuffer(): void {
    if (this.buffer.length === 0) return;
    const kept = this.buffer.filter((entry) => this.isWindowKept(entry.windowStart));
    this.buffer.length = 0;
    this.buffer.push(...kept);
  }

  private emit(level: LogLevel, source: string, message: string): void {
    const entry: LogEntry = {
      tMs: Date.now(),
      level,
      source,
      message,
      windowStart: this.currentWindowStart ?? undefined,
    };
    this.buffer.push(entry);
    this.pruneBuffer();

    const line = `[${source}] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line); // success + info

    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}

export const logService = new LogService();

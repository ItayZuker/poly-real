export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  tMs: number;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_BUFFER = 500;

type LogListener = (entry: LogEntry) => void;

class LogService {
  private readonly buffer: LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();

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

  getRecent(): LogEntry[] {
    return [...this.buffer];
  }

  onEntry(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(level: LogLevel, source: string, message: string): void {
    const entry: LogEntry = {
      tMs: Date.now(),
      level,
      source,
      message,
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }

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

/**
 * Structured JSON logger. Zero-dependency by design: emits one JSON object
 * per line so any log aggregator (Datadog, Axiom, CloudWatch, Vercel logs)
 * can ingest it without adapters. Swap the sink here if a vendor SDK is
 * ever needed — call sites never change.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogContext {
  [key: string]: unknown;
}

function activeLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: LogLevel, message: string, context: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...context,
  };
  const line = JSON.stringify(entry, (_key, value) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export function createLogger(base: LogContext = {}): Logger {
  return {
    debug: (message, context = {}) => emit("debug", message, { ...base, ...context }),
    info: (message, context = {}) => emit("info", message, { ...base, ...context }),
    warn: (message, context = {}) => emit("warn", message, { ...base, ...context }),
    error: (message, context = {}) => emit("error", message, { ...base, ...context }),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger({ app: "ai-receptionist" });

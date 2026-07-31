type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: any;
}

const formatLog = (level: LogLevel, message: string, meta?: Record<string, any>): string => {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };

  if (process.env.NODE_ENV === 'production') {
    return JSON.stringify(entry);
  }

  // Pretty format for development
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${entry.timestamp}] [${entry.level}] ${message}${metaStr}`;
};

// ── In-memory log ring buffer (for the Server Monitoring "Logs" tab) ────────
// Deliberately dependency-free (no imports beyond built-ins) — logger.ts is
// imported by config/env.ts and nearly every other module, so pulling in
// anything here risks a circular import. Per-instance and lost on restart by
// design (see plan: "in-memory ring buffer, not a Cloud Logging integration").
// Fixed-size circular buffer, not push()+shift(), so a busy instance doesn't
// pay an O(n) array-shift cost on every single log call once the buffer fills.
const LOG_BUFFER_CAPACITY = 1000;
const logBuffer: LogEntry[] = new Array(LOG_BUFFER_CAPACITY);
let bufferWriteIndex = 0;
let bufferCount = 0;

const REDACT_KEY_PATTERN = /secret|password|token|authorization|apikey|api_key|private_key|credential/i;

const redactMeta = (meta?: Record<string, any>): Record<string, any> | undefined => {
  if (!meta) return meta;
  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(meta)) {
    redacted[key] = REDACT_KEY_PATTERN.test(key) ? '[redacted]' : value;
  }
  return redacted;
};

const pushToBuffer = (level: LogLevel, message: string, meta?: Record<string, any>): void => {
  logBuffer[bufferWriteIndex] = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...redactMeta(meta),
  };
  bufferWriteIndex = (bufferWriteIndex + 1) % LOG_BUFFER_CAPACITY;
  if (bufferCount < LOG_BUFFER_CAPACITY) bufferCount++;
};

/** Newest-first, optionally filtered by level (exact match) and a case-insensitive substring search over message. */
export const getRecentLogs = (options?: { level?: string; search?: string; limit?: number }): LogEntry[] => {
  const { level, search, limit = 200 } = options || {};

  // Read out in chronological order first (oldest → newest), then reverse.
  const ordered: LogEntry[] =
    bufferCount < LOG_BUFFER_CAPACITY
      ? logBuffer.slice(0, bufferCount)
      : [...logBuffer.slice(bufferWriteIndex), ...logBuffer.slice(0, bufferWriteIndex)];

  let entries = ordered.reverse();

  if (level) {
    const wantLevel = level.toUpperCase();
    entries = entries.filter((e) => e.level === wantLevel);
  }
  if (search) {
    const needle = search.toLowerCase();
    entries = entries.filter((e) => e.message.toLowerCase().includes(needle));
  }

  return entries.slice(0, Math.max(0, Math.min(limit, LOG_BUFFER_CAPACITY)));
};

const log = (level: LogLevel, message: string, meta?: Record<string, any>): void => {
  const formatted = formatLog(level, message, meta);
  pushToBuffer(level, message, meta);

  switch (level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'debug':
      if (process.env.NODE_ENV === 'development') {
        console.debug(formatted);
      }
      break;
    default:
      console.log(formatted);
  }
};

export const logger = {
  info: (message: string, meta?: Record<string, any>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, any>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, any>) => log('error', message, meta),
  debug: (message: string, meta?: Record<string, any>) => log('debug', message, meta),
};

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultLogRoot = resolve(projectRoot, "logs", "ai-sessions");
const SECRET_KEY_PATTERN = /api[_-]?key|authorization|credential|password|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|x-goog-api-key/i;
const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;

export interface SessionLogOptions {
  rootDir?: string;
  secrets?: readonly string[];
  now?: () => Date;
  pid?: number;
}

export interface SessionLogger {
  readonly sessionId: string;
  readonly filePath: string;
  log(event: string, payload: unknown): Promise<void>;
  flush(): Promise<void>;
}

const safeTimestamp = (date: Date): string =>
  date.toISOString().replaceAll(":", "-").replaceAll(".", "-");

const serializableError = (error: Error): Record<string, unknown> => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
  cause: error.cause,
  ...Object.fromEntries(
    Object.entries(error as Error & Record<string, unknown>)
      .filter(([key]) => !["name", "message", "stack", "cause"].includes(key)),
  ),
});

const redactString = (value: string, secrets: readonly string[]): string => {
  let redacted = value.replace(GOOGLE_API_KEY_PATTERN, "[REDACTED_GOOGLE_API_KEY]");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join("[REDACTED_SECRET]");
  }
  return redacted;
};

const normalizeForLog = (
  value: unknown,
  secrets: readonly string[],
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) return normalizeForLog(serializableError(value), secrets, seen);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((item) => normalizeForLog(item, secrets, seen));
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED_SECRET_FIELD]"
      : normalizeForLog(item, secrets, seen);
  }
  seen.delete(value);
  return output;
};

export const createSessionLogger = ({
  rootDir = process.env.AI_SESSION_LOG_DIR || defaultLogRoot,
  secrets = [],
  now = () => new Date(),
  pid = process.pid,
}: SessionLogOptions = {}): SessionLogger => {
  const sessionId = `${safeTimestamp(now())}-pid-${pid}-${randomUUID()}`;
  const filePath = resolve(rootDir, `${sessionId}.jsonl`);
  let pending: Promise<void> = mkdir(rootDir, { recursive: true }).then(() => undefined);

  const write = async (event: string, payload: unknown): Promise<void> => {
    const entry = {
      timestamp: now().toISOString(),
      sessionId,
      pid,
      event,
      payload: normalizeForLog(payload, secrets),
    };
    pending = pending
      .then(() => appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8"))
      .catch(() => undefined);
    await pending;
  };

  const logger: SessionLogger = {
    sessionId,
    filePath,
    log: write,
    flush: async () => { await pending; },
  };

  void logger.log("session_started", {
    cwd: process.cwd(),
    logFile: filePath,
    note: "Gemini planner session logging started. Credentials are redacted; planner payloads and model data are logged verbosely.",
  });

  return logger;
};

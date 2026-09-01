import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, resolve, sep } from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createGeminiPlannerProvider,
  createPlannerHandler,
  type PlannerProvider,
} from "./planner";
import { createSessionLogger, type SessionLogger } from "./session-log";

const DEFAULT_PORT = 8_787;
const PROVIDER_TIMEOUT_MS = 7_000;
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultDistRoot = resolve(projectRoot, "dist");
const defaultEnvFile = resolve(projectRoot, ".env");

const parseEnvLine = (line: string): [string, string] | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const separator = trimmed.indexOf("=");
  if (separator <= 0) return null;

  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = trimmed.slice(separator + 1).trim();
  const quote = value[0];
  if (
    (quote === "\"" || quote === "'")
    && value.endsWith(quote)
    && value.length >= 2
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
};

export const loadServerEnv = (envFile = defaultEnvFile): void => {
  let body: string;
  try {
    body = readFileSync(envFile, "utf8");
  } catch {
    return;
  }

  for (const line of body.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed === null) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

const apiJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const toWebRequest = (request: IncomingMessage): Request => {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, init);
};

const writeWebResponse = async (target: ServerResponse, source: Response): Promise<void> => {
  const headers: Record<string, string> = {};
  source.headers.forEach((value, key) => {
    headers[key] = value;
  });
  target.writeHead(source.status, headers);
  target.end(Buffer.from(await source.arrayBuffer()));
};

const contentType = (path: string): string => {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
};

const serveProductionAsset = async (
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string,
): Promise<void> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    apiJson(response, 405, { error: { code: "method_not_allowed", message: "Only GET and HEAD are allowed." } });
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
  } catch {
    apiJson(response, 400, { error: { code: "invalid_path", message: "Request path was invalid." } });
    return;
  }
  const candidate = resolve(staticRoot, `.${pathname}`);
  const withinDist = candidate === staticRoot || candidate.startsWith(`${staticRoot}${sep}`);
  let file = withinDist && extname(candidate) !== "" ? candidate : resolve(staticRoot, "index.html");
  try {
    await access(file);
  } catch {
    file = resolve(staticRoot, "index.html");
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": contentType(file),
      ...(file.endsWith("index.html") ? { "cache-control": "no-store" } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    apiJson(response, 404, { error: { code: "not_found", message: "Resource not found." } });
  }
};

export interface VillageBrainServerOptions {
  envFile?: string | false;
  logDir?: string;
  logging?: boolean;
  provider?: PlannerProvider;
  production?: boolean;
  staticRoot?: string;
}

export type VillageBrainServer = ReturnType<typeof createServer> & {
  aiSessionLog?: Pick<SessionLogger, "sessionId" | "filePath">;
};

export const createVillageBrainServer = (options: VillageBrainServerOptions = {}) => {
  if (options.envFile !== false) loadServerEnv(options.envFile);
  const logger = options.provider === undefined && options.logging !== false
    ? createSessionLogger({
        rootDir: options.logDir,
        secrets: [process.env.GOOGLE_API_KEY ?? ""],
      })
    : undefined;
  const provider = options.provider ?? createGeminiPlannerProvider({ logger });
  const planner = createPlannerHandler({ provider, timeoutMs: PROVIDER_TIMEOUT_MS });
  const production = options.production ?? process.env.NODE_ENV === "production";
  const staticRoot = resolve(options.staticRoot ?? defaultDistRoot);
  const configured = Boolean(process.env.GOOGLE_API_KEY);
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  void logger?.log("server_configured", {
    production,
    staticRoot,
    planner: { configured, model },
    port: process.env.PORT ?? DEFAULT_PORT,
  });

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://local").pathname;
      if (pathname === "/api/health" && request.method === "GET") {
        apiJson(response, 200, { ok: true, planner: { configured, model } });
        return;
      }
      if (pathname === "/api/plan") {
        await writeWebResponse(response, await planner(toWebRequest(request)));
        return;
      }
      if (pathname.startsWith("/api/")) {
        apiJson(response, 404, { error: { code: "not_found", message: "API route not found." } });
        return;
      }
      if (production) {
        await serveProductionAsset(request, response, staticRoot);
        return;
      }
      apiJson(response, 404, { error: { code: "not_found", message: "Use the Vite development server." } });
    } catch {
      if (!response.headersSent) {
        apiJson(response, 500, { error: { code: "internal_error", message: "Internal server error." } });
      } else {
        response.end();
      }
    }
  });
  return Object.assign(server, {
    aiSessionLog: logger === undefined
      ? undefined
      : { sessionId: logger.sessionId, filePath: logger.filePath },
  }) satisfies VillageBrainServer;
};

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const configuredPort = Number(process.env.PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : DEFAULT_PORT;
  const server = createVillageBrainServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Village Brain server listening on http://127.0.0.1:${port}`);
    if (server.aiSessionLog !== undefined) {
      console.log(`AI session log: ${server.aiSessionLog.filePath}`);
    }
  });
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlannerProvider } from "./planner";
import { createVillageBrainServer, loadServerEnv } from "./index";

const unusedProvider: PlannerProvider = {
  async plan() {
    throw new Error("health and static requests must not invoke the provider");
  },
};

const close = async (server: ReturnType<typeof createVillageBrainServer>) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
  });
};

describe("Village Brain Node host", () => {
  afterEach(() => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.PORT;
    vi.unstubAllEnvs();
  });

  it("loads server-only planner settings from a local env file without overriding shell env", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "village-brain-env-"));
    const envFile = join(tempRoot, ".env");
    await writeFile(envFile, [
      "GOOGLE_API_KEY=file-key",
      "GEMINI_MODEL=gemini-from-file",
      "PORT=9999",
    ].join("\n"));

    vi.stubEnv("GEMINI_MODEL", "gemini-from-shell");
    delete process.env.GOOGLE_API_KEY;
    delete process.env.PORT;

    try {
      loadServerEnv(envFile);

      expect(process.env.GOOGLE_API_KEY).toBe("file-key");
      expect(process.env.GEMINI_MODEL).toBe("gemini-from-shell");
      expect(process.env.PORT).toBe("9999");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves credential-safe health JSON and the production SPA fallback", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GEMINI_MODEL", "test-model");
    const staticRoot = await mkdtemp(join(tmpdir(), "village-brain-static-"));
    await writeFile(join(staticRoot, "index.html"), "<main>Village Brain SPA</main>");
    const server = createVillageBrainServer({
      provider: unusedProvider,
      production: true,
      staticRoot,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
      const origin = `http://127.0.0.1:${address.port}`;

      const health = await fetch(`${origin}/api/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(await health.json()).toEqual({
        ok: true,
        planner: { configured: false, model: "test-model" },
      });

      const fallback = await fetch(`${origin}/village/event/active`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toContain("text/html");
      expect(await fallback.text()).toBe("<main>Village Brain SPA</main>");
    } finally {
      await close(server);
      await rm(staticRoot, { recursive: true, force: true });
    }
  });

  it("reports planner configuration loaded from the env file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "village-brain-env-"));
    const envFile = join(tempRoot, ".env");
    await writeFile(envFile, [
      "GOOGLE_API_KEY=file-key",
      "GEMINI_MODEL=gemini-from-file",
    ].join("\n"));
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_MODEL;
    const server = createVillageBrainServer({
      envFile,
      provider: unusedProvider,
      production: false,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
      const origin = `http://127.0.0.1:${address.port}`;

      const health = await fetch(`${origin}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        ok: true,
        planner: { configured: true, model: "gemini-from-file" },
      });
    } finally {
      await close(server);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

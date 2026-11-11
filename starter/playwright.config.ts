import { defineConfig } from "@playwright/test";
import { E2E_PORTS, e2eStackEnv } from "./e2e/infra";

// Names and ports are this project's own (e2e/infra.ts), so another project's
// run on the same machine never shares a container or a port with this one.
const E2E_SERVER_PORT = String(E2E_PORTS.server);
const E2E_CLIENT_PORT = String(E2E_PORTS.client);

export default defineConfig({
  testDir: "./e2e",
  // The Electron harness lives in e2e/desktop and brings its own config,
  // servers and build (e2e/desktop/playwright.config.ts). Without this it
  // would also run here, against a browser and the wrong servers.
  // e2e/export checks the static export (playwright.export.config.ts).
  testIgnore: ["desktop/**", "export/**"],
  // Removes the containers e2e/start-server.sh started for THIS run, and only
  // those: a container it found already running is left alone.
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: `http://127.0.0.1:${E2E_CLIENT_PORT}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "bash e2e/start-server.sh",
      url: `http://127.0.0.1:${E2E_SERVER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        ...e2eStackEnv(),
        NODE_ENV: "test",
        PORT: E2E_SERVER_PORT,
        MONGODB_URI:
          process.env.MONGODB_URI ??
          `mongodb://127.0.0.1:${E2E_PORTS.mongo}/starter-e2e`,
        REDIS_URL: process.env.REDIS_URL ?? `redis://127.0.0.1:${E2E_PORTS.redis}`,
        BETTER_AUTH_SECRET: "e2e-test-secret",
        BETTER_AUTH_URL: `http://127.0.0.1:${E2E_SERVER_PORT}`,
        FRONTEND_URL: `http://127.0.0.1:${E2E_CLIENT_PORT}`,
        S3_ENDPOINT: process.env.S3_ENDPOINT ?? `http://127.0.0.1:${E2E_PORTS.s3}`,
        S3_FORCE_PATH_STYLE: "true",
        S3_BUCKET_NAME: "starter-e2e",
        S3_PUBLIC_URL:
          process.env.S3_PUBLIC_URL ??
          `http://127.0.0.1:${E2E_PORTS.s3}/starter-e2e`,
        AWS_ACCESS_KEY_ID: "hatchkit-dev",
        AWS_SECRET_ACCESS_KEY: "hatchkit-dev",
        AWS_REGION: "us-east-1",
      },
    },
    {
      command: `pnpm --filter @starter/client run dev`,
      url: `http://127.0.0.1:${E2E_CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        PORT: E2E_CLIENT_PORT,
        // The tests browse 127.0.0.1; next dev (16) blocks its own dev
        // resources for any origin not listed, so nothing would hydrate.
        NEXT_DEV_ORIGINS: "127.0.0.1",
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${E2E_SERVER_PORT}`,
        NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${E2E_SERVER_PORT}`,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

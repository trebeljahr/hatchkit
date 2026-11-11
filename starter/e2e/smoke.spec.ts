import { test, expect } from "@playwright/test";
import { E2E_PORTS } from "./infra";

test.describe("Smoke tests", () => {
  test("landing page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Welcome to My App")).toBeVisible();
  });

  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });

  test("signup page loads", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByText("Create an account")).toBeVisible();
  });

  test("health endpoint returns ok", async ({ request }) => {
    // The API under test, on this project's own port (e2e/infra.ts).
    const serverUrl = process.env.NEXT_PUBLIC_API_URL ?? `http://127.0.0.1:${E2E_PORTS.server}`;
    const response = await request.get(`${serverUrl}/api/health`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });
});

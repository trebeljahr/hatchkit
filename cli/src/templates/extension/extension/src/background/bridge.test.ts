/**
 * Who may drive the bridge, and what an unreadable message gets back.
 *
 * These are the checks that have no visible failure mode: a framed page
 * is a page, another extension's message looks like a page's, and a
 * version this build cannot read looks like a malformed one. Each of
 * them would "work" in the sense of not throwing.
 */
import { describe, expect, it } from "vitest";
import {
  EXTENSION_BRIDGE_CHANNEL,
  EXTENSION_BRIDGE_VERSION,
  extensionBridgeSyncRequest,
} from "@starter/shared/extension-bridge";
import { isWebAppOrigin, screenExternalMessage, type BridgeSender } from "./bridge";

const WEB = "http://localhost:3000";
const API = "http://localhost:5000";

const topLevelPage = (origin: string): BridgeSender => ({
  origin,
  frameId: 0,
  tab: { id: 7, incognito: false },
});

const message = (): unknown =>
  extensionBridgeSyncRequest(API, { userId: "user-1", sessionCreatedAt: 1000 });

describe("screening a message from a page", () => {
  it("accepts a top-level page of an allowed origin", () => {
    const result = screenExternalMessage(message(), topLevelPage(WEB), "development");
    expect(result.ok).toBe(true);
  });

  it("says nothing at all to an origin this build does not list", () => {
    const result = screenExternalMessage(message(), topLevelPage("https://evil.example"), "development");
    // Not even a refusal: a stranger does not learn that an extension
    // is listening.
    expect(result).toEqual({ ok: false, reply: undefined });
  });

  it("refuses a frame", () => {
    // Any site can frame the web app. A cross-site frame gets no
    // SameSite=Lax cookie, so it honestly reports nobody signed in —
    // which would sign a linked extension out.
    const framed = { ...topLevelPage(WEB), frameId: 3 };
    expect(screenExternalMessage(message(), framed, "development")).toEqual({
      ok: false,
      reply: undefined,
    });
  });

  it("refuses another extension", () => {
    const other: BridgeSender = { origin: WEB, id: "abcdefghijklmnopabcdefghijklmnop", frameId: 0 };
    expect(screenExternalMessage(message(), other, "development")).toEqual({
      ok: false,
      reply: undefined,
    });
  });

  it("refuses a sender with no tab, and an incognito one", () => {
    expect(screenExternalMessage(message(), { origin: WEB, frameId: 0 }, "development").ok).toBe(false);
    const incognito = { ...topLevelPage(WEB), tab: { id: 7, incognito: true } };
    expect(screenExternalMessage(message(), incognito, "development").ok).toBe(false);
  });

  it("refuses everything on a build with no bridge", () => {
    // The Firefox build. `registerBridgeListener` does not even
    // register, and this is the second line of the same statement.
    expect(screenExternalMessage(message(), topLevelPage(WEB), "none").ok).toBe(false);
  });

  it("answers an unreadable version with `unsupported`, never a guess", () => {
    const future = { channel: EXTENSION_BRIDGE_CHANNEL, v: EXTENSION_BRIDGE_VERSION + 1, kind: "sync" };
    const result = screenExternalMessage(future, topLevelPage(WEB), "development");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reply).toMatchObject({ kind: "unsupported" });
    }
  });

  it("says nothing to a message that is not ours at all", () => {
    expect(screenExternalMessage({ hello: true }, topLevelPage(WEB), "development")).toEqual({
      ok: false,
      reply: undefined,
    });
  });
});

describe("the sender must be the web app of the current server", () => {
  it("accepts the same origin", () => {
    expect(isWebAppOrigin(WEB, WEB, "development")).toBe(true);
  });

  it("treats localhost and 127.0.0.1 as one host in development only", () => {
    expect(isWebAppOrigin("http://127.0.0.1:3000", WEB, "development")).toBe(true);
    expect(isWebAppOrigin("http://127.0.0.1:3000", WEB, "production")).toBe(false);
  });

  it("refuses a different port, which is a different app", () => {
    expect(isWebAppOrigin("http://localhost:4000", WEB, "development")).toBe(false);
  });
});

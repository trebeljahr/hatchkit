/**
 * The narrowings that make an extension sign-out safe to act on.
 *
 * Each case below was a way for the old shared-cookie behaviour to sign
 * out somebody it had no business signing out — or to keep signing them
 * out after they had signed back in.
 */
import { describe, expect, it } from "vitest";
import { EXTENSION_SIGN_OUT_MARKER_TTL_MS } from "@starter/shared/extension-bridge";
import { isLinkBlocked, signOutMarkerVerdict, type SignOutMarker } from "./sign-out-marker";

const API = "https://api.example.com";
const marker = (over: Partial<SignOutMarker> = {}): SignOutMarker => ({
  userId: "user-1",
  apiOrigin: API,
  at: 5_000,
  ...over,
});

describe("sign-out marker", () => {
  it("signs out the same person whose web session is older than the sign-out", () => {
    expect(
      signOutMarkerVerdict(marker(), API, { userId: "user-1", sessionCreatedAt: 1_000 }, 6_000),
    ).toBe("sign-out-web");
  });

  it("never signs out a different account", () => {
    expect(
      signOutMarkerVerdict(marker(), API, { userId: "user-2", sessionCreatedAt: 1_000 }, 6_000),
    ).toBe("discard");
  });

  it("lets somebody sign back in on the web afterwards", () => {
    // The whole point of comparing against `createdAt`: a session that
    // began AFTER the sign-out is a newer decision.
    expect(
      signOutMarkerVerdict(marker(), API, { userId: "user-1", sessionCreatedAt: 9_000 }, 9_500),
    ).toBe("discard");
  });

  it("says nothing about another server", () => {
    expect(
      signOutMarkerVerdict(
        marker(),
        "https://api.other.example",
        { userId: "user-1", sessionCreatedAt: 1_000 },
        6_000,
      ),
    ).toBe("discard");
  });

  it("expires", () => {
    const now = 5_000 + EXTENSION_SIGN_OUT_MARKER_TTL_MS + 1;
    expect(
      signOutMarkerVerdict(marker(), API, { userId: "user-1", sessionCreatedAt: 1_000 }, now),
    ).toBe("discard");
  });

  it("has nothing to say to a signed-out page", () => {
    expect(signOutMarkerVerdict(marker(), API, { userId: null, sessionCreatedAt: null }, 6_000)).toBe(
      "discard",
    );
  });
});

describe("link block", () => {
  it("blocks a web session that began before the sign-out, whoever it belongs to", () => {
    expect(isLinkBlocked({ apiOrigin: API, at: 5_000 }, API, 1_000)).toBe(true);
  });

  it("blocks a session whose start is unknown: it cannot be shown to be newer", () => {
    expect(isLinkBlocked({ apiOrigin: API, at: 5_000 }, API, null)).toBe(true);
  });

  it("lets a newer web session link again", () => {
    expect(isLinkBlocked({ apiOrigin: API, at: 5_000 }, API, 6_000)).toBe(false);
  });

  it("is scoped to one server", () => {
    expect(isLinkBlocked({ apiOrigin: API, at: 5_000 }, "https://api.other.example", 1_000)).toBe(
      false,
    );
  });
});

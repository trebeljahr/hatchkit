import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopTrayState } from "../../packages/shared/src/desktop-bridge.ts";
import {
  FALLBACK_TRAY_LABELS,
  parseNotice,
  parseTrayState,
  trayIconFile,
  trayMenuTemplate,
  trayTooltip,
} from "./tray-model.ts";

const signedIn: DesktopTrayState = {
  signedIn: true,
  status: "3 open",
  items: [
    { key: "k1", label: "Review", hint: "Client — Project", checked: false, disabled: false },
    { key: "k2", label: "Archive", hint: null, checked: true, disabled: false },
    { key: "k3", label: "Sync", hint: null, checked: false, disabled: true },
  ],
  badge: 3,
  labels: { ...FALLBACK_TRAY_LABELS, itemsHeading: "Weiter", quit: "Beenden" },
};

const ids = (state: DesktopTrayState | null, context = {}): string[] =>
  trayMenuTemplate(state, context).map(
    (entry) => entry.id ?? (entry.type === "separator" ? "---" : `# ${entry.label}`),
  );

describe("trayMenuTemplate", () => {
  it("signed out, or before any state: Open and Quit only", () => {
    for (const state of [null, { ...signedIn, signedIn: false }]) {
      assert.deepEqual(ids(state), ["open", "---", "quit"]);
    }
  });

  it("signed in: status, the items under their heading, Open, Settings, Quit", () => {
    assert.deepEqual(ids(signedIn), [
      "# 3 open",
      "---",
      "# Weiter",
      "item:k1",
      "item:k2",
      "item:k3",
      "---",
      "open",
      "settings",
      "---",
      "quit",
    ]);
    const labels = trayMenuTemplate(signedIn).map((entry) => entry.label);
    assert.ok(labels.includes("Beenden"), "every word comes from the payload");
  });

  it("draws a checked item as a checkbox and a disabled one as disabled", () => {
    const entries = trayMenuTemplate(signedIn);
    const checked = entries.find((entry) => entry.id === "item:k2");
    assert.equal(checked?.type, "checkbox");
    assert.equal(checked?.checked, true);
    assert.equal(entries.find((entry) => entry.id === "item:k3")?.enabled, false);
    assert.equal(entries.find((entry) => entry.id === "item:k1")?.enabled, true);
  });

  it("joins a hint onto the item's own line, and falls back to the key", () => {
    const entries = trayMenuTemplate(signedIn);
    const first = entries.find((entry) => entry.id === "item:k1");
    assert.equal(first?.label, "Review — Client — Project");
    assert.equal(entries.find((entry) => entry.id === "item:k2")?.label, "Archive");
    const blank = trayMenuTemplate({
      ...signedIn,
      items: [{ key: "k9", label: "  ", hint: null }],
    });
    assert.equal(blank.find((entry) => entry.id === "item:k9")?.label, "k9");
  });

  it("drops an empty heading and an empty status without leaving a stray separator", () => {
    const state: DesktopTrayState = {
      ...signedIn,
      status: null,
      labels: { ...signedIn.labels, itemsHeading: "" },
    };
    assert.deepEqual(ids(state), [
      "item:k1",
      "item:k2",
      "item:k3",
      "---",
      "open",
      "settings",
      "---",
      "quit",
    ]);
  });

  it("with no items: Open and Settings, no heading and no empty section", () => {
    assert.deepEqual(ids({ ...signedIn, status: null, items: [] }), [
      "open",
      "settings",
      "---",
      "quit",
    ]);
  });

  it("offers Restart to update above Quit only once an update is downloaded", () => {
    assert.equal(ids(signedIn).includes("restart-to-update"), false);
    assert.deepEqual(ids(signedIn, { updateReady: true }).slice(-2), ["restart-to-update", "quit"]);
    const out = ids(null, { updateReady: true });
    assert.deepEqual(out, ["open", "---", "restart-to-update", "quit"]);
    const entry = trayMenuTemplate(
      { ...signedIn, labels: { ...signedIn.labels, restartToUpdate: "Neu starten" } },
      { updateReady: true },
    ).find((candidate) => candidate.id === "restart-to-update");
    assert.equal(entry?.label, "Neu starten");
  });
});

describe("trayTooltip", () => {
  it("is the status beside the app name, and the idle label without one", () => {
    assert.equal(trayTooltip(signedIn), "{{projectName}} · 3 open");
    assert.equal(trayTooltip({ ...signedIn, status: "  " }), "{{projectName}}");
    assert.equal(trayTooltip(null), "{{projectName}}");
    assert.equal(trayTooltip({ ...signedIn, signedIn: false }), "{{projectName}}");
  });
});

describe("trayIconFile", () => {
  it("is a template image on macOS, an .ico on Windows and a PNG on Linux", () => {
    assert.equal(trayIconFile("darwin"), "trayTemplate.png");
    assert.equal(trayIconFile("win32"), "tray.ico");
    assert.equal(trayIconFile("linux"), "tray.png");
  });
});

describe("parseTrayState", () => {
  it("refuses a payload without signedIn", () => {
    assert.equal(parseTrayState({ items: [] }), null);
    assert.equal(parseTrayState("x"), null);
    assert.equal(parseTrayState(null), null);
  });

  it("drops keyless items, caps the list and keeps only known labels", () => {
    const parsed = parseTrayState({
      signedIn: true,
      status: "on",
      items: [
        { label: "no key" },
        ...Array.from({ length: 12 }, (_, index) => ({ key: `k${index}`, label: `r${index}` })),
      ],
      badge: 4.7,
      labels: { quit: "Beenden", evil: "<script>" },
    });
    assert.equal(parsed?.items.length, 8, "MAX_TRAY_ITEMS");
    assert.equal(parsed?.items[0]?.key, "k0");
    assert.equal(parsed?.items[0]?.hint, null);
    assert.equal(parsed?.badge, 4);
    assert.equal(parsed?.labels.quit, "Beenden");
    assert.equal("evil" in (parsed?.labels ?? {}), false);
  });

  it("signed out carries no status and no items", () => {
    const parsed = parseTrayState({ ...signedIn, signedIn: false });
    assert.equal(parsed?.status, null);
    assert.deepEqual(parsed?.items, []);
  });

  it("falls back to defaults for a bad badge and bad labels", () => {
    const parsed = parseTrayState({ signedIn: true, badge: "many", labels: 7 });
    assert.equal(parsed?.badge, 0);
    assert.deepEqual(parsed?.labels, FALLBACK_TRAY_LABELS);
  });
});

describe("parseNotice", () => {
  it("needs a title and gives an untagged notice one", () => {
    assert.equal(parseNotice({ body: "x" }), null);
    assert.equal(parseNotice({ title: "  " }), null);
    assert.deepEqual(parseNotice({ title: "Waiting", body: "Two items" }), {
      title: "Waiting",
      body: "Two items",
      tag: "notice",
    });
    assert.equal(parseNotice({ title: "Waiting", tag: "queue" })?.tag, "queue");
  });
});

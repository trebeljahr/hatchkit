/**
 * The popup.
 *
 * It owns no state: every action is one message to the background
 * worker, which answers with the whole snapshot. The popup is rebuilt
 * from scratch on every open, so keeping state here would be keeping a
 * copy that is already out of date.
 *
 * The one thing it says that nothing else can: an UNTRUSTED ORIGIN. A
 * refused cross-origin request reaches `fetch` as a bare TypeError,
 * which is indistinguishable from an outage — so the worker re-asks
 * `/api/health` (which answers `*` and gets through either way) and the
 * snapshot carries `originTrusted`. Without this notice, a server that
 * has simply not been told about the extension looks broken forever.
 */
import type { PopupCommand, PopupResult, PopupSnapshot } from "../background/index.js";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element as T;
};

const send = (command: PopupCommand): Promise<PopupResult> =>
  chrome.runtime.sendMessage(command) as Promise<PopupResult>;

const showError = (message: string | null): void => {
  const node = byId("error");
  node.textContent = message ?? "";
  node.hidden = message === null;
};

const render = (snapshot: PopupSnapshot): void => {
  byId("app").textContent = snapshot.signedIn ? "Signed in." : "Not signed in on this browser.";
  byId("signed-out").hidden = snapshot.signedIn;
  byId("signed-in").hidden = !snapshot.signedIn;
  byId("who").textContent = snapshot.signedIn
    ? `Session: ${snapshot.source ?? "unknown"}${snapshot.userId === null ? "" : ` · ${snapshot.userId}`}`
    : "";
  (byId("server-input") as HTMLInputElement).value = snapshot.apiUrl;

  byId("origin-notice").hidden = snapshot.originTrusted !== false;
  byId("extension-origin").textContent = snapshot.extensionOrigin;
  // A `moz-extension://<uuid>` origin is new on every install, so
  // listing it is not advice anybody can follow.
  byId("firefox-hint").hidden = !snapshot.extensionOrigin.startsWith("moz-extension://");
};

const run = async (command: PopupCommand): Promise<void> => {
  showError(null);
  const result = await send(command);
  if (result.ok) {
    render(result.snapshot);
    return;
  }
  showError(result.message);
  // A refused origin is worth showing even when the command failed for
  // another reason: the next attempt will fail the same way.
  const refresh = await send({ type: "popup:snapshot" });
  if (refresh.ok) render(refresh.snapshot);
};

byId("sign-in").addEventListener("click", () => {
  void run({
    type: "popup:sign-in",
    email: (byId("email") as HTMLInputElement).value.trim(),
    password: (byId("password") as HTMLInputElement).value,
  });
});

byId("device-sign-in").addEventListener("click", () => {
  void run({ type: "popup:device-sign-in" });
});

byId("sign-out").addEventListener("click", () => {
  void run({ type: "popup:sign-out" });
});

byId("server-save").addEventListener("click", () => {
  void run({
    type: "popup:set-server",
    origin: (byId("server-input") as HTMLInputElement).value.trim(),
  });
});

void run({ type: "popup:snapshot" });

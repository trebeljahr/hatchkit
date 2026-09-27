/**
 * Create an item without opening a window.
 *
 * ============================================================
 * WHY THIS IS ITS OWN COMMAND
 * ============================================================
 *
 * `no-view` is the reason it exists. A global hotkey can only drive a
 * background-capable mode — `no-view` or a menu bar command — and a view
 * command opens a window before it can do anything. Folding this into the form
 * command would silently cost the hotkey, which is the entire point of it.
 *
 * ============================================================
 * AND WHY IT STILL ANSWERS WHEN NOTHING IS SET UP
 * ============================================================
 *
 * Raycast lists a command whether or not the state it acts on exists, so this
 * one will be invoked with no title, with no argument, and before the
 * extension has ever been paired. Each of those has to answer usefully rather
 * than fail: an unpaired capture still QUEUES the work — which is exactly the
 * work pairing later claims and sends — and says so.
 */
import { Clipboard, LaunchProps, Toast, getPreferenceValues, open, showToast } from "@raycast/api";
import { createItem, describeFailure } from "./lib/api";
import { readSessionState } from "./lib/auth";
import { webOrigin } from "./lib/preferences";

export default async function Command(
  props: LaunchProps<{ arguments: Arguments.CaptureItem }>,
): Promise<void> {
  const { openAfterCapture } = getPreferenceValues<Preferences.CaptureItem>();

  // The argument, else whatever is on the clipboard. A hotkey pressed with no
  // argument is the common case, and refusing it would make the hotkey useless
  // for the thing hotkeys are for.
  const typed = props.arguments.title?.trim() ?? "";
  const title = typed !== "" ? typed : ((await Clipboard.readText()) ?? "").trim();

  if (title === "") {
    await showToast({
      style: Toast.Style.Failure,
      title: "Nothing to capture",
      message: "Type a title after the command, or copy some text first.",
    });
    return;
  }

  const session = await readSessionState();
  try {
    const result = await createItem({ title: title.slice(0, 200) });
    if (result.sent) {
      await showToast({ style: Toast.Style.Success, title: "Captured", message: title });
      if (openAfterCapture) await open(webOrigin());
      return;
    }
    await showToast({
      style: Toast.Style.Success,
      title: "Queued",
      message:
        session.status === "signed-in"
          ? "Saved here. It will be sent when the server answers."
          : "Saved here. Pair with the web app and it will be sent then.",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not capture",
      message: describeFailure(error),
    });
  }
}

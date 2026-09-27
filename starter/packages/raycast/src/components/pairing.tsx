/**
 * Pairing, pushed from wherever a person already is.
 *
 * ============================================================
 * WHY THERE IS NO "SIGN IN" COMMAND
 * ============================================================
 *
 * Raycast has no runtime visibility control: a command is listed whether or not
 * it applies. A sign-in command would therefore sit in the launcher forever,
 * including for the many months somebody is already paired, and it would be the
 * command they hit by accident. So pairing is an ACTION on the empty state of
 * every surface instead — it appears exactly when it is the thing to do.
 *
 * ============================================================
 * AND IT NEVER OPENS A BROWSER ON MOUNT
 * ============================================================
 *
 * Everything here runs from an action a person chose. Nothing below is called
 * from an effect. A list that failed to load must not throw an approval page at
 * the browser on the person's behalf — the person may be offline, may be
 * looking at a cached list quite happily, or may have pointed the extension at
 * the wrong origin by mistake.
 */
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  List,
  Toast,
  open,
  showToast,
} from "@raycast/api";
import { runDeviceSignIn } from "../lib/device-sign-in";
import { apiOrigin } from "../lib/preferences";

/**
 * Run a pairing attempt with progress in a toast.
 *
 * The user code is copied to the clipboard as well as shown: the approval page
 * usually arrives with the code prefilled, but a browser that opens in a
 * profile with no session will bounce through a sign-in first and lose it.
 */
export async function pairNow(onDone?: () => void): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Pairing…" });
  const result = await runDeviceSignIn({
    openApproval: (url) => open(url),
    onProgress: (progress) => {
      if (progress.phase === "waiting") {
        void Clipboard.copy(progress.userCode);
        toast.title = `Approve code ${progress.userCode}`;
        toast.message = "The approval page is open in your browser. The code is on your clipboard.";
      }
    },
  });

  if (!result.ok) {
    toast.style = Toast.Style.Failure;
    toast.title = "Not paired";
    toast.message = result.reason;
    return;
  }
  toast.style = Toast.Style.Success;
  toast.title = result.email === null ? "Paired" : `Paired as ${result.email}`;
  toast.message =
    result.claimed > 0
      ? `${result.claimed} change(s) you made before pairing were sent.`
      : undefined;
  onDone?.();
}

/** The action itself, for any surface that has an action panel. */
export function PairAction({ onDone }: { onDone?: () => void }): React.JSX.Element {
  return (
    <Action
      title="Pair with the Web App"
      icon={Icon.Link}
      onAction={() => {
        void pairNow(onDone);
      }}
    />
  );
}

/**
 * The empty state a list shows when there is no credential for this origin.
 *
 * `other-server` is its own message. A credential issued by another origin is
 * not a broken session — it is a credential for a server this install is no
 * longer pointed at, and saying "signed out" would send the person looking for
 * a fault that is not there.
 */
export function PairingEmptyView({
  state,
  onDone,
}: {
  state: "signed-out" | "other-server";
  issuedBy?: string;
  onDone?: () => void;
}): React.JSX.Element {
  const origin = apiOrigin();
  return (
    <List.EmptyView
      icon={{ source: Icon.Link, tintColor: Color.Blue }}
      title={state === "other-server" ? "Signed in to a different server" : "Not paired yet"}
      description={
        state === "other-server"
          ? `Your stored session belongs to another server. Pair with ${origin} to use it here.`
          : `Pair this extension with ${origin}. You approve a short code in your browser; no password is typed here.`
      }
      actions={
        <ActionPanel>
          <PairAction onDone={onDone} />
        </ActionPanel>
      }
    />
  );
}

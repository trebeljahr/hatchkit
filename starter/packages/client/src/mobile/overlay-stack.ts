/*
 * A LIFO registry of things the hardware back button should close before it
 * does anything else.
 *
 * Why a registry and not a scan of the DOM: a dialog knows how to close itself
 * (it owns the state), and back has to close the TOP one — the one the user is
 * looking at — not the first one in document order. Document order is mount
 * order, which after a few opens and closes bears no relation to what is on
 * top.
 *
 * Deliberately not React state: the back-button listener is registered once,
 * outside React, at bridge init. Anything it reads has to be readable from
 * there, synchronously, at the moment the press arrives.
 */

export type OverlayClose = () => void;

/**
 * Entries are objects rather than bare functions so identity is guaranteed
 * unique. Two dialogs that happen to pass the same closure — easy with a
 * shared `close` helper — must still be two independent entries.
 */
interface OverlayEntry {
  close: OverlayClose;
}

const stack: OverlayEntry[] = [];

/**
 * Registers an overlay and returns ITS OWN teardown.
 *
 * The teardown removes the EXACT entry it pushed, found by identity, never
 * "the top one". React unmounts are not ordered the way opens were: a parent
 * can unmount while a child overlay is still registered, and a `pop()` here
 * would silently discard a different overlay's entry — leaving a visible
 * dialog unreachable by back, and a closed one still counted.
 */
export function pushOverlay(close: OverlayClose): () => void {
  const entry: OverlayEntry = { close };
  stack.push(entry);

  let removed = false;
  return () => {
    // Idempotent: a double teardown (StrictMode, or close-then-unmount) must
    // not remove a second, unrelated entry.
    if (removed) return;
    removed = true;
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
  };
}

/**
 * Closes the topmost overlay. Returns whether there was one.
 *
 * The entry is removed here as well as by the overlay's own teardown: `close()`
 * only asks the owner to update its state, and until React re-renders and the
 * effect cleanup runs, the entry is still on the stack. Two back presses in
 * quick succession would otherwise both target the same dialog and the second
 * would be swallowed.
 */
export function closeTopOverlay(): boolean {
  const entry = stack.pop();
  if (!entry) return false;
  try {
    entry.close();
  } catch {
    // A throwing close must still count as handled — the entry is already off
    // the stack, and letting it propagate would take down the back listener.
  }
  return true;
}

/** How many overlays are registered. For diagnostics and for tests. */
export function overlayCount(): number {
  return stack.length;
}

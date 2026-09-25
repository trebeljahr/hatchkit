"use client";

/*
 * Minimal controlled dialog primitive. No dependencies beyond React.
 *
 * It exists in this shape for one reason: THE OVERLAY IS REGISTERED HERE, ONCE,
 * INSTEAD OF AT EVERY CALL SITE. The Android back button closes the top overlay
 * (see mobile/back-button.ts), which only works if every overlay is on the
 * stack. Asking each screen to remember `pushOverlay` means the one dialog
 * someone forgets swallows the back press and does nothing — a dead button on
 * a screen the user cannot leave. Centralising it here makes forgetting
 * impossible.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pushOverlay } from "@/mobile/overlay-stack";
import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  /**
   * Required for the dialog to participate in back handling.
   *
   * REGISTERED ONLY WHEN CONTROLLED. An uncontrolled dialog has no way to be
   * closed from the outside, so registering it would put an entry on the stack
   * whose `close` does nothing: back would be consumed, the dialog would stay
   * open, and the press would be lost. Better to leave such a dialog off the
   * stack and let back do the next thing.
   */
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  className?: string;
  /** Accessible name. Use when the dialog has no visible heading. */
  label?: string;
}

export function Dialog({
  open,
  onOpenChange,
  children,
  className,
  label,
}: DialogProps) {
  /*
   * Portals need a DOM. Under `output: "export"` this component is prerendered
   * in Node, so the first client render must match the server's — which is
   * nothing. Mounting is flipped in an effect, after hydration, so there is no
   * mismatch to suppress.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Kept in a ref so the overlay registration below does not have to re-run
  // whenever the parent passes a fresh closure.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const controlled = onOpenChange !== undefined;

  useEffect(() => {
    if (!open || !controlled) return;
    return pushOverlay(() => onOpenChangeRef.current?.(false));
  }, [open, controlled]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onOpenChangeRef.current?.(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => onOpenChangeRef.current?.(false)}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn(
          // Centred with translate utilities on purpose: styles/native.css
          // re-anchors this to the top on phones by setting --tw-translate-y,
          // and the comment there explains why that, and not `transform`.
          "absolute left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
          "rounded-lg border border-border bg-background p-6 text-foreground shadow-lg",
          "max-h-[calc(100dvh-2rem)] overflow-y-auto",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

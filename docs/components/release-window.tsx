"use client";
import { useState, type ComponentType } from "react";

export function ReleaseWindow() {
  const [Details, setDetails] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  async function show() {
    try {
      const module = await import("./release-window-details");
      setDetails(() => module.default);
    } catch { setFailed(true); }
  }
  return <div>
    <button type="button" className="rounded border px-3 py-2 text-sm" onClick={show}>Check this site&apos;s release window</button>
    {Details ? <Details /> : null}
    {failed ? <p role="status">The release details could not load. Refresh this page to retry.</p> : null}
  </div>;
}

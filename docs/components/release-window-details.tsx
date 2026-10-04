"use client";
import { useEffect, useState } from "react";
export default function ReleaseWindowDetails() {
  const [releases, setReleases] = useState<string[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/releases.json", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (data?.schema === 2 && Array.isArray(data.releases) && data.releases.length <= 6 && data.releases.every((id: unknown) => typeof id === "string" && /^[a-f0-9]{40}$/.test(id))) setReleases(data.releases); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return <div aria-live="polite">
    <p>This site keeps the current release and two prior releases for open tabs.</p>
    <p>Tabs outside this window reload the same URL, including its query and fragment.</p>
    {releases ? <ul>{releases.map((id, index) => <li key={id}>{`Available ${index + 1}`}: <code>{id.slice(0, 12)}</code></li>)}</ul> : <p>Release details are unavailable.</p>}
  </div>;
}

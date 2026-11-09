import { ImageResponse } from "next/og";

export const alt = "hatchkit documentation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-static";

// The hatchkit egg (docs/public/img/favicon.svg), inlined so the static render needs no fetch.
const EGG_MARK =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSI+CiAgPHRpdGxlPkhhdGNoa2l0IGhhdGNoaW5nIGVnZyBmYXZpY29uPC90aXRsZT4KICA8ZGVmcz4KICAgIDxjbGlwUGF0aCBpZD0iZWdnLWNsaXAiPgogICAgICA8cGF0aCBkPSJNMTYgNS41QzIxLjIgNS41IDI1IDExLjEgMjUgMTguMkMyNSAyNCAyMS4xIDI4IDE2IDI4QzEwLjkgMjggNyAyNCA3IDE4LjJDNyAxMS4xIDEwLjggNS41IDE2IDUuNVoiLz4KICAgIDwvY2xpcFBhdGg+CiAgPC9kZWZzPgogIDxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgcng9IjciIGZpbGw9IiM4MThjZjgiLz4KICA8cGF0aCBkPSJNMTYgNS41QzIxLjIgNS41IDI1IDExLjEgMjUgMTguMkMyNSAyNCAyMS4xIDI4IDE2IDI4QzEwLjkgMjggNyAyNCA3IDE4LjJDNyAxMS4xIDEwLjggNS41IDE2IDUuNVoiIGZpbGw9IiNmZmZmZmYiLz4KICA8ZyBjbGlwLXBhdGg9InVybCgjZWdnLWNsaXApIj4KICAgIDxwYXRoIGQ9Ik02LjQgMTYuNUw5LjUgMTMuN0wxMi4zIDE3LjFMMTUgMTMuNkwxNy44IDE3TDIwLjUgMTMuN0wyMy40IDE2LjVMMjUuOCAxNC40IiBzdHJva2U9IiMwYjBkMTIiIHN0cm9rZS13aWR0aD0iMS44NSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgPC9nPgo8L3N2Zz4K";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "linear-gradient(135deg, #061826 0%, #104e64 55%, #7c3aed 100%)",
          color: "white",
          fontFamily: "Inter, Arial, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: 0,
          }}
        >
          <img src={EGG_MARK} width={52} height={52} alt="" />
          hatchkit docs
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.02, letterSpacing: 0 }}>
            Scaffold and ship on infrastructure you own.
          </div>
          <div style={{ maxWidth: 900, fontSize: 34, lineHeight: 1.25, color: "rgba(255,255,255,0.86)" }}>
            Full-stack TypeScript apps, provider setup, deployment, and GPU-backed ML services from one CLI.
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 26, color: "rgba(255,255,255,0.82)" }}>
          <span>CLI</span>
          <span>/</span>
          <span>TypeScript</span>
          <span>/</span>
          <span>self-owned infra</span>
        </div>
      </div>
    ),
    size,
  );
}

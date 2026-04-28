"use client";

import { useEffect, useRef } from "react";

type Model3dViewerProps = {
  glbUrl: string;
  vertices?: number;
};

export function Model3dViewer({ glbUrl, vertices }: Model3dViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Dynamically load model-viewer if not already loaded
    if (!customElements.get("model-viewer")) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js";
      document.head.appendChild(script);
    }
  }, []);

  return (
    <div className="space-y-3" data-testid="3d-viewer">
      <div className="overflow-hidden rounded-lg border bg-muted/30" style={{ height: 400 }}>
        {/* @ts-expect-error model-viewer is a custom element */}
        <model-viewer
          src={glbUrl}
          alt="Generated 3D model"
          auto-rotate
          camera-controls
          shadow-intensity="1"
          environment-image="neutral"
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        {vertices ? <span>{vertices.toLocaleString()} vertices</span> : <span />}
        <a
          href={glbUrl}
          download="model.glb"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          Download GLB
        </a>
      </div>
    </div>
  );
}

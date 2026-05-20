"use client";

import { useState, useRef } from "react";

type ComparisonViewerProps = {
  beforeSrc: string;
  afterSrc: string;
  beforeLabel?: string;
  afterLabel?: string;
};

export function ComparisonViewer({
  beforeSrc,
  afterSrc,
  beforeLabel = "Original",
  afterLabel = "Result",
}: ComparisonViewerProps) {
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  function handleMove(clientX: number) {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setSliderPos((x / rect.width) * 100);
  }

  return (
    <div
      ref={containerRef}
      className="relative select-none overflow-hidden rounded-lg border"
      style={{ aspectRatio: "4 / 3" }}
      onMouseMove={(e) => {
        if (e.buttons === 1) handleMove(e.clientX);
      }}
      onTouchMove={(e) => handleMove(e.touches[0].clientX)}
      data-testid="comparison-viewer"
    >
      {/* Before image (full) */}
      <img
        src={beforeSrc}
        alt={beforeLabel}
        className="absolute inset-0 h-full w-full object-contain"
        draggable={false}
      />

      {/* After image (clipped) */}
      <img
        src={afterSrc}
        alt={afterLabel}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
        draggable={false}
      />

      {/* Slider line */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg cursor-ew-resize"
        style={{ left: `${sliderPos}%` }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white p-1.5 shadow">
          <svg className="h-4 w-4 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M8 6l-4 6 4 6M16 6l4 6-4 6" />
          </svg>
        </div>
      </div>

      {/* Labels */}
      <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {beforeLabel}
      </span>
      <span className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {afterLabel}
      </span>
    </div>
  );
}

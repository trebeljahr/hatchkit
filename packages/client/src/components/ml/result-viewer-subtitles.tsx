"use client";

type SubtitleSegment = {
  start: number;
  end: number;
  text: string;
};

type SubtitleViewerProps = {
  segments: SubtitleSegment[];
  srt?: string;
  language?: string;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}

export function SubtitleViewer({ segments, srt, language }: SubtitleViewerProps) {
  function handleDownloadSrt() {
    if (!srt) return;
    const blob = new Blob([srt], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "subtitles.srt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4" data-testid="subtitle-viewer">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {segments.length} segments{language ? ` · ${language}` : ""}
        </div>
        {srt && (
          <button
            onClick={handleDownloadSrt}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Download SRT
          </button>
        )}
      </div>

      <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border p-3">
        {segments.map((seg, i) => (
          <div key={i} className="flex gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {formatTime(seg.start)}
            </span>
            <span className="text-sm">{seg.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

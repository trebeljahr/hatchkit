"use client";

type RecognitionLabel = {
  label: string;
  score: number;
};

type ImageRecognitionViewerProps = {
  imageSrc: string;
  results: RecognitionLabel[];
};

export function ImageRecognitionViewer({
  imageSrc,
  results,
}: ImageRecognitionViewerProps) {
  const maxScore = results.length > 0 ? results[0].score : 1;

  return (
    <div className="grid gap-6 md:grid-cols-2" data-testid="recognition-viewer">
      <div className="overflow-hidden rounded-lg border">
        <img
          src={imageSrc}
          alt="Analyzed image"
          className="h-full w-full object-contain"
        />
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Classification Results</h3>
        {results.map((r, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className={i === 0 ? "font-medium" : "text-muted-foreground"}>
                {r.label}
              </span>
              <span className="font-mono text-xs tabular-nums">
                {(r.score * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${i === 0 ? "bg-primary" : "bg-primary/40"}`}
                style={{ width: `${(r.score / maxScore) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

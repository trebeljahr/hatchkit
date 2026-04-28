"use client";

import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { FileDropzone } from "@/components/ml/file-dropzone";
import { ImageRecognitionViewer } from "@/components/ml/result-viewer-image";

const DEFAULT_LABELS = [
  "a photo of a person",
  "a photo of an animal",
  "a photo of food",
  "a photo of a building",
  "a photo of a vehicle",
  "a photo of nature",
  "a photo of electronics",
  "a photo of clothing",
  "a photo of art",
  "a photo of a product",
];

export default function ImageRecognitionPage() {
  const [topK, setTopK] = useState(5);
  const [customLabels, setCustomLabels] = useState("");
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  const mutation = trpc.ml.recognizeImage.useMutation();

  const handleFile = useCallback(
    (_file: File, base64: string) => {
      setImageSrc(`data:image/png;base64,${base64}`);
      const labels = customLabels.trim()
        ? customLabels.split("\n").map((l) => l.trim()).filter(Boolean)
        : undefined;
      mutation.mutate({ imageBase64: base64, labels, topK });
    },
    [topK, customLabels, mutation],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <FileDropzone
            accept={["image/jpeg", "image/png", "image/webp"]}
            maxSizeMb={20}
            onFile={handleFile}
            label="Drop an image to classify"
            disabled={mutation.isPending}
          />
        </div>
        <div className="w-64 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Top K results
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => setTopK(parseInt(e.target.value, 10))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Custom labels (one per line, or leave empty for defaults)
            </label>
            <textarea
              value={customLabels}
              onChange={(e) => setCustomLabels(e.target.value)}
              placeholder={DEFAULT_LABELS.slice(0, 3).join("\n")}
              rows={5}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      {mutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Classifying image...
        </div>
      )}

      {mutation.error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {mutation.error.message}
        </div>
      )}

      {imageSrc && mutation.data && (
        <ImageRecognitionViewer
          imageSrc={imageSrc}
          results={mutation.data.results}
        />
      )}
    </div>
  );
}

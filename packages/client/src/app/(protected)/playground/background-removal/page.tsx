"use client";

import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { FileDropzone } from "@/components/ml/file-dropzone";
import { ComparisonViewer } from "@/components/ml/result-viewer-comparison";

export default function BackgroundRemovalPage() {
  const [model, setModel] = useState<"birefnet-general" | "u2net" | "isnet-general-use">("birefnet-general");
  const [originalSrc, setOriginalSrc] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const mutation = trpc.ml.removeBackground.useMutation({
    onSuccess: (data) => {
      setResultUrl(data.imageUrl);
    },
  });

  const handleFile = useCallback(
    (_file: File, base64: string) => {
      setOriginalSrc(`data:image/png;base64,${base64}`);
      setResultUrl(null);
      mutation.mutate({ imageBase64: base64, model });
    },
    [model, mutation],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4">
        <div className="flex-1">
          <FileDropzone
            accept={["image/jpeg", "image/png", "image/webp"]}
            maxSizeMb={20}
            onFile={handleFile}
            label="Drop an image to remove its background"
            disabled={mutation.isPending}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Model
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as typeof model)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            disabled={mutation.isPending}
          >
            <option value="birefnet-general">BiRefNet (best quality)</option>
            <option value="u2net">U2Net (faster)</option>
            <option value="isnet-general-use">ISNet (general)</option>
          </select>
        </div>
      </div>

      {mutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Removing background...
        </div>
      )}

      {mutation.error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {mutation.error.message}
        </div>
      )}

      {originalSrc && resultUrl && (
        <ComparisonViewer
          beforeSrc={originalSrc}
          afterSrc={resultUrl}
          beforeLabel="Original"
          afterLabel="Background Removed"
        />
      )}
    </div>
  );
}

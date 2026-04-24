"use client";

import { useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { FileDropzone } from "@/components/ml/file-dropzone";
import { Model3dViewer } from "@/components/ml/result-viewer-3d";

export default function SamBodyPage() {
  const mutation = trpc.ml.generate3dSamBody.useMutation();

  const handleFile = useCallback(
    (_file: File, base64: string) => {
      mutation.mutate({ imageBase64: base64 });
    },
    [mutation],
  );

  return (
    <div className="space-y-6">
      <FileDropzone
        accept={["image/jpeg", "image/png", "image/webp"]}
        maxSizeMb={20}
        onFile={handleFile}
        label="Drop a photo of a person to reconstruct posed body (SAM 3D Body)"
        disabled={mutation.isPending}
      />

      <p className="text-xs text-muted-foreground">
        Estimates body shape and pose from a single image. Suitable for apparel
        try-on and avatar-style rendering. Best results with full-body, well-lit
        photos against a clean background.
      </p>

      {mutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Reconstructing body... (~30 seconds on A100)
        </div>
      )}

      {mutation.error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {mutation.error.message}
        </div>
      )}

      {mutation.data && (
        <Model3dViewer
          glbUrl={mutation.data.glbUrl}
          vertices={mutation.data.vertices}
        />
      )}
    </div>
  );
}

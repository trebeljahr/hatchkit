"use client";

import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { FileDropzone } from "@/components/ml/file-dropzone";
import { Model3dViewer } from "@/components/ml/result-viewer-3d";

export default function Hunyuan3dPage() {
  const [removeBg, setRemoveBg] = useState(true);
  const [withTexture, setWithTexture] = useState(true);

  const mutation = trpc.ml.generate3dHunyuan.useMutation();

  const handleFile = useCallback(
    (_file: File, base64: string) => {
      mutation.mutate({ imageBase64: base64, removeBg, withTexture });
    },
    [removeBg, withTexture, mutation],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4">
        <div className="flex-1">
          <FileDropzone
            accept={["image/jpeg", "image/png", "image/webp"]}
            maxSizeMb={20}
            onFile={handleFile}
            label="Drop a product photo for Hunyuan3D (4-8K PBR textures)"
            disabled={mutation.isPending}
          />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeBg}
              onChange={(e) => setRemoveBg(e.target.checked)}
              className="rounded border"
              disabled={mutation.isPending}
            />
            Auto-remove background
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withTexture}
              onChange={(e) => setWithTexture(e.target.checked)}
              className="rounded border"
              disabled={mutation.isPending}
            />
            Generate textures (slower)
          </label>
        </div>
      </div>

      {mutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Generating with Hunyuan3D... ({withTexture ? "~60s with textures" : "~30s geometry only"})
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
